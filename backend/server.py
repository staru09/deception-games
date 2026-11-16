"""Serve the 3D viewer and the game data on localhost.

    python server.py [--port 8000] [--games ./autonomous_games] [--host 127.0.0.1]

    /            -> ../frontend/
    /games/...   -> the games directory (index.json, <id>/config.json, <id>/events.jsonl, ...)

The games directory holds full prompts and reasoning traces, so the default host is
127.0.0.1. Reach it from another machine with an SSH tunnel:
    ssh -L 8000:127.0.0.1:8000 <host>
"""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"


class Handler(SimpleHTTPRequestHandler):
    games_dir = None  # set in main()
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".jsonl": "application/x-ndjson", ".glb": "model/gltf-binary",
                      ".mjs": "text/javascript"}

    def translate_path(self, path):
        # super() resolves against self.directory and already blocks ".." traversal
        if path.startswith("/games/"):
            self.directory, path = str(self.games_dir), path[len("/games"):]
        else:
            self.directory = str(FRONTEND_DIR)
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # live games grow while being watched
        super().end_headers()

    def log_message(self, *args):
        pass  # the viewer polls every second; per-request logs would bury everything else


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--games", default="./autonomous_games", help="games directory to serve")
    args = parser.parse_args()
    Handler.games_dir = Path(args.games).resolve()
    print(f"Viewer: http://{args.host}:{args.port}/   (games from {Handler.games_dir})",
          flush=True)
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
