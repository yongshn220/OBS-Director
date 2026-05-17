"""Entry point.

Run: python app.py
Then open: http://127.0.0.1:8765/
"""
import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "backend.server:app",
        host="127.0.0.1",
        port=8765,
        reload=False,
        log_level="info",
    )
