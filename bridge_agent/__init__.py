import asyncio
import json
import logging
import time
from typing import Callable, Any, Optional

try:
    import websockets
except ImportError:
    websockets = None

logger = logging.getLogger("bridge_agent")

class BridgeContext:
    def __init__(self, agent: "BridgeAgent", task_id: str, room_id: str, prompt: str):
        self.agent = agent
        self.task_id = task_id
        self.room_id = room_id
        self.prompt = prompt

    async def progress(self, text: str, percent: Optional[float] = None, eta: Optional[int] = None, partial_output: Optional[str] = None):
        msg = {
            "type": "progress",
            "task_id": self.task_id,
            "text": text,
            "percent": percent,
            "eta_seconds": eta,
            "partial_output": partial_output
        }
        await self.agent._send(msg)

    async def ask(self, question: str, to: str = "caller", timeout: float = 300.0) -> str:
        """Asks a question to a participant and blocks until an answer arrives or timeout."""
        msg = {
            "type": "question",
            "task_id": self.task_id,
            "question": question,
            "to": to
        }
        future = asyncio.get_event_loop().create_future()
        self.agent._pending_questions[self.task_id] = future
        await self.agent._send(msg)

        try:
            answer = await asyncio.wait_for(future, timeout=timeout)
            return answer
        finally:
            self.agent._pending_questions.pop(self.task_id, None)

    async def notify(self, message: str, to: str = "all"):
        msg = {
            "type": "progress",
            "task_id": self.task_id,
            "text": f"Notification to {to}: {message}",
            "partial_output": message
        }
        await self.agent._send(msg)


class BridgeAgent:
    def __init__(self, agent_id: str, token: str, bridge_ws_url: str = "ws://127.0.0.1:3001/agent/ws"):
        self.agent_id = agent_id
        self.token = token
        self.bridge_ws_url = bridge_ws_url
        self.handler: Optional[Callable[[BridgeContext], Any]] = None
        self.ws = None
        self._pending_questions = {}
        self.running = False

    def on_task(self, handler: Callable[[BridgeContext], Any]):
        self.handler = handler
        return handler

    async def _send(self, payload: dict):
        if self.ws:
            await self.ws.send(json.dumps(payload))

    async def run(self):
        if websockets is None:
            raise RuntimeError("websockets library is required. Install via 'pip install websockets'")

        self.running = True
        backoff = 1.0

        while self.running:
            try:
                logger.info(f"Connecting to Bridge at {self.bridge_ws_url}...")
                async with websockets.connect(self.bridge_ws_url) as ws:
                    self.ws = ws
                    backoff = 1.0
                    # Send hello
                    await self._send({
                        "type": "hello",
                        "agent_id": self.agent_id,
                        "token": self.token
                    })

                    # Listen loop
                    async for raw_msg in ws:
                        msg = json.loads(raw_msg)
                        mtype = msg.get("type")

                        if mtype == "ping":
                            await self._send({"type": "pong"})
                        elif mtype == "ack":
                            logger.info(f"Bridge ack: {msg}")
                        elif mtype == "task":
                            asyncio.create_task(self._handle_task(msg))
                        elif mtype == "answer":
                            task_id = msg.get("task_id")
                            if task_id in self._pending_questions:
                                self._pending_questions[task_id].set_result(msg.get("answer"))
                        elif mtype == "cancel":
                            logger.info(f"Task cancelled: {msg.get('task_id')}")

            except (websockets.ConnectionClosed, OSError) as e:
                logger.warning(f"Connection dropped: {e}. Retrying in {backoff}s...")
                await asyncio.sleep(backoff)
                backoff = min(backoff * 1.5, 15.0)
            except Exception as e:
                logger.error(f"Unexpected error in run loop: {e}", exc_info=True)
                await asyncio.sleep(backoff)

    async def _handle_task(self, task_msg: dict):
        task_id = task_msg["task_id"]
        room_id = task_msg["room_id"]
        prompt = task_msg["prompt"]

        await self._send({"type": "ack", "task_id": task_id})
        ctx = BridgeContext(self, task_id, room_id, prompt)

        try:
            if not self.handler:
                raise RuntimeError("No task handler registered")
            
            res = self.handler(ctx)
            if asyncio.iscoroutine(res):
                res = await res

            await self._send({
                "type": "result",
                "task_id": task_id,
                "result": res
            })
        except Exception as e:
            logger.error(f"Task execution failed: {e}", exc_info=True)
            await self._send({
                "type": "error",
                "task_id": task_id,
                "error": str(e)
            })

    def start(self):
        asyncio.run(self.run())
