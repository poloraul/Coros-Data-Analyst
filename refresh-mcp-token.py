#!/opt/homebrew/bin/python3
"""Refresh COROS MCP auth token: login via API and save to npm coros-mcp token file."""
import asyncio, sys, json, time, os

sys.path.insert(0, os.path.expanduser('~/.local/share/uv/tools/coros-training-mcp/lib/python3.14/site-packages'))
import coros_api, httpx

TOKEN_PATH = os.path.expanduser("~/.coros-mcp-skill-gateway-ts/cn/token.json")

async def main():
    # Login via coros_api
    auth = await coros_api.login('poloraul@126.com', '19870810wy', 'asia')

    # Try to call MCP to verify token works
    mcp_url = "https://mcpcn.coros.com/mcp"
    headers = {"Authorization": f"Bearer {auth.access_token}", "Content-Type": "application/json"}

    # Test: call list_tools
    async with httpx.AsyncClient(timeout=10) as client:
        # Initialize
        init_payload = {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"token-refresh","version":"1.0"}}}
        resp = await client.post(mcp_url, json=init_payload, headers=headers)
        init_result = resp.json()
        if init_result.get("error"):
            print(f"❌ MCP init failed: {init_result['error']}")
            print("Token may be invalid for MCP - trying token exchange...")
            return

        # Test tools/list
        list_payload = {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
        resp2 = await client.post(mcp_url, json=list_payload, headers=headers)
        tools_result = resp2.json()
        tool_count = len(tools_result.get("result", {}).get("tools", []))
        print(f"✅ MCP connected, {tool_count} tools available")

    # Save token to npm coros-mcp file
    token_data = {
        "access_token": auth.access_token,
        "refresh_token": "",
        "expires_at_epoch": int(time.time()) + 86400 * 7,  # estimate 7 days
        "token_type": "Bearer",
        "scope": "mcp.tools openid offline_access",
        "client_id": "ccd9bd8c-6504-4b83-80ab-edad29e075cc",
    }
    with open(TOKEN_PATH, "w") as f:
        json.dump(token_data, f, indent=2)
    print(f"✅ Token saved to {TOKEN_PATH}")

asyncio.run(main())
