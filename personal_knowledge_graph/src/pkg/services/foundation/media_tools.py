import asyncio
import subprocess


async def run_media_command(command: list[str], *, timeout: int) -> tuple[bytes, bytes]:
    process = await asyncio.create_subprocess_exec(
        *command,
        stdin=subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except TimeoutError:
        process.kill()
        await process.wait()
        raise TimeoutError(f"Command timed out: {command[0]}") from None
    if process.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(detail or f"Command failed: {command[0]}")
    return stdout, stderr
