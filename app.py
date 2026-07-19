"""Entry point.

Run: python app.py
Then open: http://<this-mac-ip>:8765/  (or http://127.0.0.1:8765/ locally)
"""
import os

import uvicorn

if __name__ == "__main__":
    # Bind to 0.0.0.0 so the control surface is reachable from other devices on
    # the SAME LAN (observe/adjust from a phone or laptop at
    # http://<this-mac-ip>:8765). The frontend talks to location.host, so LAN
    # access needs no client change.
    #
    # Override with AI_HOST=127.0.0.1 to restrict back to this machine only.
    # SECURITY: there is no authentication — anyone on the network who opens the
    # URL can control the director (incl. LIVE OBS commands). Only run this on a
    # trusted/dedicated production network.
    host = os.environ.get("AI_HOST", "0.0.0.0")
    port = int(os.environ.get("AI_PORT", "8765"))
    uvicorn.run(
        "backend.server:app",
        host=host,
        port=port,
        reload=False,
        log_level="info",
    )
