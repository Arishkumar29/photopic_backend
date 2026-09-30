"""Find every photo of the selfie's person in an event.

A single cosine cut-off can't be right for everyone: a genuine phone selfie can
score 0.45 against an event photo, while a look-alike sibling can score 0.55.
Photos of the same person *within* the event, though, are easy to tell apart
(same camera, lighting, clothes). So:

1. Candidates: event faces the selfie scores >= SEED against.
2. Group the candidates into identities by average event-to-event similarity (LINK).
3. Accept an identity if its best face is STRONG, or, for the top identity only,
   if it is CORROBORATED (>= CORROBORATED in at least two different photos).
   A lone borderline face is how look-alikes got in, so it is not enough.
4. Expand: add event faces that closely resemble an accepted face (EXPAND),
   which recovers profiles and poses the selfie itself can't vouch for.

Thresholds are AuraFace cosines, calibrated on labelled GWC event photos.
"""
from dataclasses import dataclass

import numpy as np

SEED = 0.40
STRONG = 0.62
CORROBORATED = 0.50
LINK = 0.62
EXPAND = 0.62
FLOOR = 0.30  # an expanded face must still look somewhat like the selfie
MAX_CANDIDATES = 60


@dataclass
class PhotoMatch:
    file_id: str
    score: float  # best selfie similarity of any matched face in the photo


def match(selfie: np.ndarray, file_ids: list[str], faces: np.ndarray) -> list[PhotoMatch]:
    if not len(faces):
        return []
    scores = (faces @ selfie.T).max(axis=1)  # best over the selfie variants
    candidates = [int(i) for i in np.argsort(-scores)[:MAX_CANDIDATES] if scores[i] >= SEED]
    if not candidates:
        return []

    # Best-first grouping: a face joins the group it resembles *on average*. Joining
    # on a single close pair let A~B~C chains merge look-alikes into one identity.
    groups: list[list[int]] = []
    for i in candidates:
        affinity = [float((faces[g] @ faces[i]).mean()) for g in groups]
        if affinity and max(affinity) >= LINK:
            groups[int(np.argmax(affinity))].append(i)
        else:
            groups.append([i])

    accepted: list[int] = []
    for rank, group in enumerate(groups):  # already ordered by best selfie score
        best = scores[group].max()
        photos_backing = {file_ids[i] for i in group if scores[i] >= CORROBORATED}
        if best >= STRONG or (rank == 0 and len(photos_backing) >= 2):
            accepted += group
    if not accepted:
        return []

    # Expand to faces that closely resemble the accepted ones: the best single match
    # must be close, and the face must fit the accepted set as a whole too.
    sims = faces @ faces[accepted].T
    top = np.sort(sims, axis=1)[:, -3:]
    near = (top[:, -1] >= EXPAND) & (top.mean(axis=1) >= EXPAND - 0.10)
    chosen = set(accepted) | {int(i) for i in np.flatnonzero(near & (scores >= FLOOR))}

    best_per_photo: dict[str, float] = {}
    for i in chosen:
        best_per_photo[file_ids[i]] = max(best_per_photo.get(file_ids[i], -1.0), float(scores[i]))
    return [PhotoMatch(fid, round(s, 4)) for fid, s in sorted(best_per_photo.items(), key=lambda kv: -kv[1])]
