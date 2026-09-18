from pydantic import BaseModel


class ReferenceRead(BaseModel):
    ref_type: str
    ref_id: str
    title: str
    subtitle: str | None = None
    href: str | None = None
    excerpt: str | None = None
    status: str | None = None
    metadata_: dict | None = None


class ReferenceResolveRequest(BaseModel):
    refs: list[dict]


class ReferenceResolveResponse(BaseModel):
    items: list[ReferenceRead]
