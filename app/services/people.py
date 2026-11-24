"""Group every face of an event into people, for the admin People view.

Faces are taken best-first (largest, most confident) and each joins the person
whose faces it resembles most on average, if that average clears JOIN; otherwise
it starts a new person. Two refinement passes then move faces to the person they
fit best now that every group is complete. A face never joins a person who is
already in the same photo (one person can't appear twice in one picture).

Average similarity (rather than the closest single face) keeps chains of
look-alikes from merging into one identity, the same rule the selfie matcher uses.
"""
import base64

import numpy as np

from . import store

JOIN = 0.50        # AuraFace cosine, average over the person's faces
MERGE = 0.48       # average cross-similarity at which two groups are one person. Same-person frontal vs profile groups measured 0.50-0.54; distinct look-alikes from ~0.45, so err on keeping them apart.
MIN_PHOTOS = 2     # a "person" seen in one photo only is listed as unassigned
REFINE_PASSES = 2

_cache: dict[str, tuple[int, dict]] = {}


def _cluster(vectors: np.ndarray, files: list[str], order: np.ndarray) -> np.ndarray:
    n = len(vectors)
    label = np.full(n, -1)
    sums: list[np.ndarray] = []      # per person: sum of member vectors
    counts: list[int] = []
    photos: list[set[str]] = []

    for i in order:
        if sums:
            # Mean cosine to a person's members = vector · (sum of members) / count.
            means = (np.stack(sums) @ vectors[i]) / np.array(counts)
            for p in np.argsort(-means):
                if means[p] < JOIN:
                    break
                if files[i] not in photos[p]:
                    label[i] = p
                    break
        if label[i] < 0:
            label[i] = len(sums)
            sums.append(np.zeros(vectors.shape[1], dtype=np.float32))
            counts.append(0)
            photos.append(set())
        p = label[i]
        sums[p] += vectors[i]
        counts[p] += 1
        photos[p].add(files[i])

    for _ in range(REFINE_PASSES):
        S = np.stack(sums)
        C = np.array(counts, dtype=np.float32)
        moved = 0
        for i in order:
            own = label[i]
            # Leave-one-out mean for the face's own person, plain mean for the others.
            own_sum = S[own] - vectors[i]
            means = (S @ vectors[i]) / np.maximum(C, 1)
            means[own] = (own_sum @ vectors[i]) / max(C[own] - 1, 1) if C[own] > 1 else -1
            best = int(np.argmax(means))
            if best != own and means[best] >= JOIN and means[best] > means[own] + 0.02:
                S[own] -= vectors[i]; C[own] -= 1
                S[best] += vectors[i]; C[best] += 1
                label[i] = best
                moved += 1
        sums, counts = list(S), list(C.astype(int))
        if not moved:
            break
    return _merge(vectors, files, label)


def _merge(vectors: np.ndarray, files: list[str], label: np.ndarray) -> np.ndarray:
    """Join people that are really one: best-first grouping can split someone whose
    first faces were a profile and a frontal shot. Merge when the average similarity
    between the two groups clears MERGE and they never share a photo."""
    label = label.copy()
    while True:
        ids = np.unique(label)
        members = {p: np.flatnonzero(label == p) for p in ids}
        sums = np.stack([vectors[members[p]].sum(0) for p in ids])
        counts = np.array([len(members[p]) for p in ids], dtype=np.float32)
        cross = (sums @ sums.T) / np.outer(counts, counts)
        np.fill_diagonal(cross, -1)
        photos = {p: {files[i] for i in members[p]} for p in ids}
        merged = False
        for flat in np.argsort(-cross, axis=None):
            a, b = divmod(int(flat), len(ids))
            if cross[a, b] < MERGE:
                break
            if a < b and not (photos[ids[a]] & photos[ids[b]]):
                label[label == ids[b]] = ids[a]
                merged = True
                break
        if not merged:
            return label


def people(event_id: str) -> dict:
    """{people: [...], total_faces, unassigned, needsReindex}. Blocking: run in a thread."""
    count = store.face_count(event_id)
    if (hit := _cache.get(event_id)) and hit[0] == count:
        return hit[1]

    rows = store.face_rows(event_id)
    if not rows:
        result = {"people": [], "total_faces": 0, "unassigned": 0, "needsReindex": False}
        _cache[event_id] = (count, result)
        return result

    vectors = np.frombuffer(b"".join(r.vector for r in rows), dtype=np.float32).reshape(-1, 512)
    files = [r.file_id for r in rows]
    # Best faces first: they define each person before weaker faces are compared.
    size = np.array([(r.box[2] if len(r.box) > 2 else 0) for r in rows], dtype=np.float32)
    quality = np.array([r.score for r in rows], dtype=np.float32) * np.sqrt(np.maximum(size, 1))
    order = np.argsort(-quality)
    label = _cluster(vectors, files, order)

    out, unassigned = [], 0
    for p in np.unique(label):
        members = np.flatnonzero(label == p)
        photo_ids = list(dict.fromkeys(files[i] for i in members[np.argsort(-quality[members])]))
        if len(photo_ids) < MIN_PHOTOS:
            unassigned += len(members)
            continue
        centroid = vectors[members].mean(0)
        centroid /= np.linalg.norm(centroid) or 1
        tight = float((vectors[members] @ centroid).mean())
        cover = next((rows[i].thumb for i in members[np.argsort(-quality[members])] if rows[i].thumb), None)
        out.append({
            "faces": int(len(members)),
            "photos": photo_ids,
            "cover": f"data:image/jpeg;base64,{base64.b64encode(cover).decode()}" if cover else None,
            "score": round(tight, 3),
        })
    out.sort(key=lambda x: (-len(x["photos"]), -x["score"]))
    for n, person in enumerate(out, 1):
        person["id"] = f"p{n}"
    result = {"people": out, "total_faces": len(rows), "unassigned": unassigned,
              "needsReindex": not any(r.thumb for r in rows)}
    _cache[event_id] = (count, result)
    return result


def forget(event_id: str) -> None:
    _cache.pop(event_id, None)
