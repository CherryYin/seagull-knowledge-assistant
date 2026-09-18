from sqlalchemy import select

from pkg.db import async_session
from pkg.models.user import UserMemory
from pkg.services.cross_cutting.user_profiler import classify_user_memory_type


async def main() -> None:
    async with async_session() as session:
        result = await session.execute(select(UserMemory))
        memories = list(result.scalars())
        updated = 0
        for memory in memories:
            inferred = classify_user_memory_type(memory.key, memory.value)
            if getattr(memory, "memory_type", None) != inferred:
                memory.memory_type = inferred
                updated += 1
        if updated:
            await session.commit()
        print(f"updated_user_memories={updated}")


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
