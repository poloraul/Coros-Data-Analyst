#!/Users/jarvis/.local/share/uv/tools/coros-training-mcp/bin/python3
"""
push-plan.py — 将 LLM 生成的周训练计划推送到 COROS 手表日历

直接调用 coros_api 模块，避免 MCP stdio 通信问题。
读取 *-analysis.json 的 weeklyPlan，创建并排程训练计划。

用法:
  ./scripts/push-plan.py                          # dry-run 预览
  ./scripts/push-plan.py --confirm                # 实际推送
  ./scripts/push-plan.py --date 20260710          # 指定日期
  ./scripts/push-plan.py --confirm --date 20260710 # 指定日期 + 推送
"""

import asyncio, sys, os, json, re, datetime

# coros_api 路径
sys.path.insert(0, '/Users/jarvis/.local/share/uv/tools/coros-training-mcp/lib/python3.14/site-packages')
import coros_api

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(PROJECT_ROOT, 'data', 'daily')


# ============================================================
# 配速工具
# ============================================================
def pace_str_to_sec(pace_str):
    """'6:10/km' → 370 (秒), '3:50-4:10/km' → (230, 250)"""
    parts = re.findall(r'(\d+):(\d+)', pace_str)
    if not parts:
        return None, None
    vals = [int(m)*60+int(s) for m, s in parts]
    return min(vals), max(vals)


def extract_pace_range(range_str):
    """
    从 paceZones.range 提取快慢配速（秒/公里）
    '6:05/km — 5:05/km' → (305, 365) 即 (faster_sec, slower_sec)
    '> 6:05/km' → (274, 365) 慢值+10%
    '< 3:51/km' → (231, 265) 快值+10%
    """
    if not range_str:
        return None
    single = re.search(r'>\s*(\d+:\d+)', range_str)
    if single:
        s = int(single.group(1))*60+int(single.group(2))
        return {'faster': int(s*0.9), 'slower': s}
    single2 = re.search(r'<\s*(\d+:\d+)', range_str)
    if single2:
        s = int(single2.group(1))*60+int(single2.group(2))
        return {'faster': s, 'slower': int(s*1.15)}
    parts = re.findall(r'(\d+):(\d+)', range_str)
    if len(parts) >= 2:
        a = int(parts[0][0])*60+int(parts[0][1])
        b = int(parts[1][0])*60+int(parts[1][1])
        return {'faster': min(a, b), 'slower': max(a, b)}
    return None


def find_pace_range(pace_zones, zone_key):
    """按 zone key 查找配速范围"""
    if not pace_zones or not zone_key:
        return None
    m = re.search(r'(Z[1-6])', zone_key)
    if not m:
        return None
    zone = next((z for z in pace_zones if z.get('key') == m.group(1)), None)
    if not zone:
        return None
    return extract_pace_range(zone.get('range', ''))


def sec_to_pace(sec):
    """秒→配速字符串"""
    if sec is None or sec <= 0:
        return ''
    return f'{int(sec)//60}:{int(sec)%60:02d}'


# ============================================================
# 训练步骤转换
# ============================================================
def _step_from_llm_workout(ws):
    """
    将 LLM workoutSteps 条目转换为 COROS step dict。
    支持格式：
      {"kind":"warmup","targetDistanceKm":2,"pace":"6:30-7:00/km"}
      {"kind":"rest","targetDurationSeconds":120}
      {"repeat":8,"steps":[{"kind":"interval",...},{"kind":"rest",...}]}
    """
    if 'repeat' in ws:
        # 间歇组
        sub_steps = []
        for sub in ws.get('steps', []):
            sub_steps.append(_step_from_llm_workout(sub))
        return {'repeat': ws['repeat'], 'name': ws.get('name', '间歇组'), 'steps': sub_steps}

    kind = ws.get('kind', 'training')
    target_type = ws.get('targetType', 'distance')

    step = {'kind': kind, 'name': ws.get('name', kind)}

    if target_type == 'time' or 'targetDurationSeconds' in ws:
        step['target_type'] = 'time'
        step['target_duration_seconds'] = int(ws['targetDurationSeconds'])
        step['target_display_unit'] = 0
    else:
        dist_km = ws.get('targetDistanceKm', 1)
        step['target_type'] = 'distance'
        step['target_distance_meters'] = round(float(dist_km) * 1000)
        step['target_display_unit'] = 0

    # 配速
    pace = ws.get('pace', '')
    if pace:
        fast_sec, slow_sec = pace_str_to_sec(pace)
        if fast_sec is not None:
            step['intensity_type'] = 3
            step['intensity_value'] = fast_sec
            step['intensity_value_extend'] = slow_sec
            step['intensity_display_unit'] = 0

    return step


def build_workout_steps(day_plan, pace_zones):
    """weeklyPlan 条目 → COROS step 列表

    优先使用 LLM 生成的 workoutSteps（确保与详细计划一致），
    无 workoutSteps 时回退到规则引擎。
    """
    tp = day_plan.get('type', '')
    total_km = day_plan.get('totalDistance', 0)

    if tp == '休息' or total_km <= 0:
        return None

    # 优先使用 LLM 的 workoutSteps
    ws_list = day_plan.get('workoutSteps')
    if ws_list and isinstance(ws_list, list) and len(ws_list) > 0:
        return [_step_from_llm_workout(ws) for ws in ws_list]

    # ===== 回退：规则引擎（无 workoutSteps 时使用） =====
    pace_range = find_pace_range(pace_zones, day_plan.get('paceZone', ''))

    # 目标配速（秒/公里 — COROS 实际使用秒，非毫秒）
    target_fast_sec = None
    target_slow_sec = None
    if pace_range:
        target_fast_sec = pace_range['faster']
        target_slow_sec = pace_range['slower']

    # 轻松配速（始终用 Z2，和训练类型无关的热身/冷身）
    z2_range = find_pace_range(pace_zones, 'Z2')
    if z2_range:
        easy_sec = z2_range['slower'] + 15  # Z2慢端+15秒
    else:
        easy_sec = 390  # 6:30/km默认

    # 热身/冷身距离
    warmup_km = max(1, round(total_km * 0.15))
    cooldown_km = max(1, round(total_km * 0.12))
    main_km = total_km - warmup_km - cooldown_km

    steps = []

    # 热身
    if warmup_km > 0:
        steps.append({
            'kind': 'warmup',
            'name': '热身',
            'target_type': 'distance',
            'target_distance_meters': round(warmup_km * 1000),
            'target_display_unit': 0,
            'intensity_type': 3,
            'intensity_value': easy_sec,
            'intensity_value_extend': easy_sec + 30,
            'intensity_display_unit': 0,
        })

    # 主训练
    if main_km > 0:
        if '间歇' in tp:
            rep_dist_m = 400
            rep_count = max(2, min(16, int((main_km * 1000) / (rep_dist_m + 200))))
            fast_sec = target_fast_sec if target_fast_sec else 250
            slow_sec = target_slow_sec if target_slow_sec else 260
            steps.append({
                'repeat': rep_count,
                'name': '间歇组',
                'steps': [
                    {
                        'kind': 'interval', 'name': '快跑',
                        'target_type': 'distance', 'target_distance_meters': rep_dist_m,
                        'target_display_unit': 0,
                        'intensity_type': 3, 'intensity_value': fast_sec,
                        'intensity_value_extend': slow_sec, 'intensity_display_unit': 0,
                    },
                    {
                        'kind': 'rest', 'name': '恢复',
                        'target_type': 'time', 'target_duration_seconds': 120,
                    },
                ],
            })
        else:
            main_fast_sec = target_fast_sec if target_fast_sec else easy_sec
            main_slow_sec = target_slow_sec if target_slow_sec else easy_sec + 30
            steps.append({
                'kind': 'training',
                'name': '长距离' if 'LSD' in tp else '主训练',
                'target_type': 'distance',
                'target_distance_meters': round(main_km * 1000),
                'target_display_unit': 0,
                'intensity_type': 3, 'intensity_value': main_fast_sec,
                'intensity_value_extend': main_slow_sec, 'intensity_display_unit': 0,
            })

    # 冷身
    if cooldown_km > 0:
        steps.append({
            'kind': 'cooldown', 'name': '冷身',
            'target_type': 'distance',
            'target_distance_meters': round(cooldown_km * 1000),
            'target_display_unit': 0,
            'intensity_type': 3, 'intensity_value': easy_sec,
            'intensity_value_extend': easy_sec + 30, 'intensity_display_unit': 0,
        })

    return steps


TYPE_NAME_MAP = {
    '轻松跑': 'Easy Run',
    '节奏跑': 'Tempo Run',
    '间歇': 'Intervals',
    'LSD': 'Long Run',
    '阈值跑': 'Threshold Run',
    '混合训练': 'Mixed Run',
}


def print_preview(opts, push_days):
    """打印推送预览"""
    print(f'\n=== 训练计划推送预览 ===')
    print(f'分析日期: {opts["date"]}')
    print(f'推送日期: {datetime.date.today().isoformat()}')
    print(f'待推送: {len(push_days)} 天')
    for day, wname, steps in push_days:
        print(f'\n📅 {day["date"]} ({day["dayName"]}) — {wname}')
        print(f'   距离: {day["totalDistance"]}km | 强度: {day.get("paceZone", "—")}')
        if steps:
            print(f'   步骤: {len(steps)} 个')
            for s in steps:
                if 'repeat' in s:
                    print(f'     - 间歇组 ×{s["repeat"]}')
                    for sub in s.get('steps', []):
                        iv = sub.get('intensity_value', 0)
                        ive = sub.get('intensity_value_extend', 0)
                        print(f'       - {sub.get("name","")}: {sec_to_pace(iv)}-{sec_to_pace(ive)}/km'
                              if iv else f'       - {sub.get("name","")}: {sub.get("target_duration_seconds",0)}s')
                else:
                    iv = s.get('intensity_value', 0)
                    ive = s.get('intensity_value_extend', 0)
                    print(f'     - {s.get("kind","")}: {sec_to_pace(iv)}-{sec_to_pace(ive)}/km'
                          if iv else f'     - {s.get("kind","")}')
        else:
            print(f'   ❌ 步骤生成失败')


async def main():
    # 解析参数
    opts = {'date': None, 'confirm': False, 'force': False, 'day': None}
    args = sys.argv[1:]
    for i, a in enumerate(args):
        if a == '--date' and i+1 < len(args):
            opts['date'] = args[i+1]
        elif a == '--confirm':
            opts['confirm'] = True
        elif a == '--force':
            opts['force'] = True
        elif a == '--day' and i+1 < len(args):
            opts['day'] = int(args[i+1])

    if not opts['date']:
        today = datetime.date.today()
        opts['date'] = today.strftime('%Y%m%d')

    # 读取分析文件
    analysis_path = os.path.join(DATA_DIR, f'{opts["date"]}-analysis.json')
    if not os.path.exists(analysis_path):
        print(f'[ERROR] 分析文件不存在: {opts["date"]}-analysis.json')
        sys.exit(1)

    with open(analysis_path, 'r') as f:
        analysis = json.load(f)

    weekly_plan = (analysis.get('analysis') or {}).get('weeklyPlan') or []
    pace_zones = (analysis.get('context') or {}).get('paceZones') or []

    if not weekly_plan:
        print('[ERROR] weeklyPlan 为空，无法推送')
        sys.exit(1)

    today_str = datetime.date.today().isoformat()

    # 构建推送条目
    push_days = []
    for day in weekly_plan:
        if day.get('type') == '休息' or day.get('totalDistance', 0) <= 0:
            continue
        if opts['day'] is not None and day.get('dayIndex') != opts['day']:
            continue
        if not opts['force'] and day.get('date', '') < today_str:
            continue

        steps = build_workout_steps(day, pace_zones)
        tp = day.get('type', '')
        wname = f'{day.get("dayName","")} {TYPE_NAME_MAP.get(tp, tp)}'
        push_days.append((day, wname, steps))

    if not push_days:
        print('没有需要推送的训练日（所有非休息日已过去或执行完毕）')
        return

    # 预览
    print_preview(opts, push_days)

    if not opts['confirm']:
        print('\n⚠️ 预览模式，未实际推送。使用 --confirm 实际推送到手表日历。')
        return

    # === 实际推送 ===
    print('\n=== 开始推送训练计划到 COROS ===')

    # 登录
    try:
        auth = await coros_api.login('poloraul@126.com', '19870810wy', 'asia')
        print('  ✅ COROS 登录成功')
    except Exception as e:
        print(f'  ❌ COROS 登录失败: {e}')
        sys.exit(1)

    # 收集推送日期范围，用于查询已有排程
    push_dates_compact = [d['date'].replace('-', '') for d, _, _ in push_days if _]
    min_date = min(push_dates_compact)
    max_date = max(push_dates_compact)

    # 查询目标日期范围内已有的排程
    existing_by_date = {}
    try:
        existing_scheds = await coros_api.fetch_scheduled_workouts(auth, min_date, max_date)
        for s in existing_scheds:
            entity = s.get('entity', {})
            happen_day = str(entity.get('happenDay', ''))
            if happen_day not in existing_by_date:
                existing_by_date[happen_day] = []
            existing_by_date[happen_day].append({
                'plan_id': s.get('plan_id'),
                'id_in_plan': s.get('id_in_plan'),
                'plan_program_id': s.get('plan_program_id'),
                'name': s.get('workout', {}).get('name', ''),
            })
        if existing_by_date:
            total_entries = sum(len(v) for v in existing_by_date.values())
            print(f'  📋 目标日期范围内已有 {total_entries} 个排程条目')
            for d, entries in sorted(existing_by_date.items()):
                names = [e['name'] for e in entries]
                print(f'     {d}: {", ".join(names)}')
    except Exception as e:
        print(f'  ⚠️ 查询已有排程失败（将继续推送）: {e}')

    results = []

    # 第一步：全量删除目标日期范围内所有旧排程
    # （包括新计划中为休息日的日期，确保无遗留）
    delete_count = 0
    for date_compact_del in sorted(existing_by_date.keys()):
        entries_del = existing_by_date[date_compact_del]
        for old in entries_del:
            try:
                await coros_api.remove_scheduled_workout(
                    auth,
                    old['plan_id'],
                    old['id_in_plan'],
                    plan_program_id=old.get('plan_program_id'),
                )
                print(f'  🗑️ 已删除: {date_compact_del} {old.get("name", "?")}')
                delete_count += 1
            except Exception as e:
                print(f'  ⚠️ 删除失败（跳过）: {date_compact_del} {old.get("name", "?")}: {e}')
    if delete_count > 0:
        print(f'  共删除 {delete_count} 个旧排程')

    # 第二步：创建并排程新计划
    for day, wname, steps in push_days:
        if not steps:
            continue

        date_compact = day['date'].replace('-', '')
        print(f'\n  🏃 {wname} ({day["date"]})')

        try:
            # 创建训练计划
            payload = coros_api.build_run_workout_payload(wname, steps)
            payload['distanceDisplayUnit'] = 0  # 系统默认单位
            wid = await coros_api.create_workout_from_raw(auth, payload)
            print(f'     ✅ 已创建, workout_id: {wid}')

            # 排程到日历
            await coros_api.schedule_workout(auth, wid, date_compact)
            print(f'     ✅ 已排程到 {date_compact}')

            results.append({
                'date': day['date'],
                'workoutName': wname,
                'workoutId': str(wid),
                'succeed': True,
            })
        except Exception as e:
            print(f'     ❌ 推送失败: {e}')
            results.append({
                'date': day['date'],
                'workoutName': wname,
                'succeed': False,
                'error': str(e),
            })

    # 结果统计
    print(f'\n=== 推送完成 ===')
    succeeded = [r for r in results if r['succeed']]
    failed = [r for r in results if not r['succeed']]
    print(f'成功: {len(succeeded)}, 失败: {len(failed)}')
    for r in succeeded:
        print(f'  ✅ {r["date"]} {r["workoutName"]} (id={r["workoutId"]})')
    for r in failed:
        print(f'  ❌ {r["date"]} {r["workoutName"]}: {r.get("error","")}')

    # 保存日志
    log_dir = os.path.join(PROJECT_ROOT, 'data', 'push-logs')
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, f'push-{opts["date"]}-{datetime.date.today().isoformat()}.json')
    with open(log_path, 'w') as f:
        json.dump({'pushedAt': datetime.datetime.now().isoformat(), 'date': opts['date'], 'results': results}, f, ensure_ascii=False, indent=2)
    print(f'日志已保存: {os.path.relpath(log_path, PROJECT_ROOT)}')
    print(f'\n请打开 COROS App 查看同步结果。')


if __name__ == '__main__':
    asyncio.run(main())
