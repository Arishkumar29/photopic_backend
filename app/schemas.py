from pydantic import BaseModel, ConfigDict


class _Body(BaseModel):
    # Clients may send extra fields (e.g. older admin builds); ignore them.
    model_config = ConfigDict(extra="ignore")


class CreateEvent(_Body):
    eventId: str | None = None
    folderId: str | None = None
    orgName: str | None = None
    eventName: str | None = None
    coverImage: str | None = None
    description: str | None = None
    eventLocation: str | None = None
    eventType: str | None = None
    eventDate: str | None = None


class UpdateEvent(_Body):
    eventName: str | None = None
    orgName: str | None = None
    coverImage: str | None = None
    description: str | None = None
    eventLocation: str | None = None
    eventType: str | None = None
    eventDate: str | None = None
    folderId: str | None = None


class ZipRequest(_Body):
    files: list[str] | None = None
    name: str | None = None


class Login(_Body):
    email: str | None = None
    password: str | None = None


class ScanFaces(_Body):
    eventId: str | None = None
    referenceImage: str | None = None  # data:image/jpeg;base64,…
