from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from pkg.schemas.action import ActionRequest, ActionResponse
from pkg.services.action_agent import create_action_agent

router = APIRouter()


@router.post("/action", response_model=ActionResponse)
async def execute_action(body: ActionRequest):
    agent = create_action_agent(callback_handler=None)

    # Replay conversation history if provided
    if body.conversation_history:
        for msg in body.conversation_history:
            agent.messages.append(msg)

    result = await agent.invoke_async(body.task)

    return ActionResponse(
        result=result.message.get("content", [{}])[0].get("text", str(result.message)),
        stop_reason=result.stop_reason or "end_turn",
    )


@router.post("/action/stream")
async def execute_action_stream(body: ActionRequest):
    agent = create_action_agent(callback_handler=None)

    if body.conversation_history:
        for msg in body.conversation_history:
            agent.messages.append(msg)

    async def event_generator():
        async for event in agent.stream_async(body.task):
            if "data" in event:
                yield event["data"]

    return StreamingResponse(event_generator(), media_type="text/plain")
