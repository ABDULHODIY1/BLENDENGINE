# SPDX-License-Identifier: GPL-2.0-or-later
#
# Compiles skinned characters and weapons into BlendEngine character assets.
#
#   python3 compile_character_assets.py <redeclipse data dir> <addon assets dir>
#
# Output per character (assets/characters/<id>/):
#   character.json  skeleton, mesh layout, clips, sockets, variants
#   character.bin   float32/uint8/uint16 arrays referenced by character.json
#   <variant>_base.png, normal.png, <variant>_orm.png, <variant>_emit.png
#
# Positions are converted to metres (Z up, facing +Y, the runtime's yaw 0 direction).
# Clips hold per-frame local joint transforms: t xyz, q xyzw, uniform scale.
# Requires numpy and Pillow.

import json
import math
import os
import shutil
import struct
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from iqm import IQM, POSITION, TEXCOORD, NORMAL, BLENDINDEXES, BLENDWEIGHTS  # noqa: E402

TARGET_HEIGHT = 1.78

# Clip name -> (file, fps, loop, part) where part is 'full', 'lower' or 'upper'.
RE_CLIPS = {
    "idle": ("idle.iqm", 10, True),
    "walk": ("walk_forward.iqm", 30, True),
    "walk_back": ("walk_backward.iqm", 30, True),
    "walk_left": ("walk_left.iqm", 35, True),
    "walk_right": ("walk_right.iqm", 35, True),
    "run": ("runcycle0.iqm", 40, True),
    "run_back": ("runbackward0.iqm", 40, True),
    "run_left": ("runstepleft0.iqm", 45, True),
    "run_right": ("runstepright0.iqm", 45, True),
    "jump": ("jump0_up.iqm", 50, False),
    "crouch": ("crouch.iqm", 10, True),
    "crouch_walk": ("crouch_forward.iqm", 30, True),
    "pain": ("pain.iqm", 20, False),
    "dying": ("dying.iqm", 21, False),
    "dead": ("dead.iqm", 10, True),
    "rifle_idle": ("rifle_idle.iqm", 1, True),
    "rifle_fire": ("rifle_primary.iqm", 24, False),
    "rifle_reload": ("rifle_reload.iqm", 5, False),
    "pistol_idle": ("gun_pose1.iqm", 1, True),
    "pistol_fire": ("gun_fire.iqm", 20, False),
    "pistol_reload": ("reload_pistol.iqm", 20, False),
    "smg_reload": ("smg_reload.iqm", 19.45, False),
    "shotgun_fire": ("sg_primary.iqm", 15, False),
}

# Armour colour schemes: (plates, undersuit, glow). Every soldier picks one, so a squad is never uniform.
VARIANTS = {
    "urban": ((0.62, 0.64, 0.66), (0.10, 0.11, 0.12), (0.3, 0.8, 1.0)),
    "desert": ((0.70, 0.58, 0.40), (0.24, 0.20, 0.14), (1.0, 0.7, 0.3)),
    "forest": ((0.33, 0.40, 0.25), (0.12, 0.14, 0.10), (0.6, 1.0, 0.4)),
    "blackops": ((0.16, 0.17, 0.19), (0.05, 0.05, 0.06), (1.0, 0.25, 0.2)),
    "crimson": ((0.55, 0.12, 0.10), (0.12, 0.08, 0.08), (1.0, 0.5, 0.2)),
    "arctic": ((0.86, 0.88, 0.90), (0.30, 0.33, 0.36), (0.4, 0.9, 1.0)),
    "navy": ((0.18, 0.26, 0.42), (0.08, 0.09, 0.12), (0.4, 0.8, 1.0)),
    "olive": ((0.42, 0.42, 0.28), (0.15, 0.15, 0.11), (1.0, 0.85, 0.4)),
}


class Blob:
    def __init__(self):
        self.data = bytearray()

    def add(self, array):
        while len(self.data) % 16:
            self.data.append(0)
        offset = len(self.data)
        self.data.extend(np.ascontiguousarray(array).tobytes())
        return offset


def quat_mul(a, b):
    ax, ay, az, aw = np.moveaxis(a, -1, 0)
    bx, by, bz, bw = np.moveaxis(b, -1, 0)
    return np.stack([aw * bx + ax * bw + ay * bz - az * by,
                     aw * by - ax * bz + ay * bw + az * bx,
                     aw * bz + ax * by - ay * bx + az * bw,
                     aw * bw - ax * bx - ay * by - az * bz], -1)


def quat_rotate(q, v):
    qv = q[..., :3]
    t = 2.0 * np.cross(qv, v)
    return v + q[..., 3:4] * t + np.cross(qv, t)


def trs_matrix(t, q, s):
    x, y, z, w = q
    m = np.eye(4)
    m[0, 0] = 1 - 2 * (y * y + z * z); m[0, 1] = 2 * (x * y - z * w); m[0, 2] = 2 * (x * z + y * w)
    m[1, 0] = 2 * (x * y + z * w); m[1, 1] = 1 - 2 * (x * x + z * z); m[1, 2] = 2 * (y * z - x * w)
    m[2, 0] = 2 * (x * z - y * w); m[2, 1] = 2 * (y * z + x * w); m[2, 2] = 1 - 2 * (x * x + y * y)
    m[:3, :3] *= np.asarray(s)
    m[:3, 3] = t
    return m


def bake_textures(src_dir, out_dir, variants):
    """Bake per-variant base colour, ORM (G = roughness, B = metal) and emission maps."""
    diffuse = np.asarray(Image.open(os.path.join(src_dir, "RE_Player_diffuse.tga")).convert("RGB"), np.float32) / 255.0
    mask = np.asarray(Image.open(os.path.join(src_dir, "RE_Player_mask.tga")).convert("RGBA"), np.float32) / 255.0
    spec, glow, env, team = mask[..., 0], mask[..., 1], mask[..., 2], mask[..., 3]
    lum = diffuse.mean(axis=2)
    Image.open(os.path.join(src_dir, "norm.png")).convert("RGB").save(os.path.join(out_dir, "normal.png"), optimize=True)
    rough = np.clip(0.78 - spec * 0.55 - env * 0.15, 0.18, 0.95)
    metal = np.clip(env * 0.6 + spec * 0.3, 0.0, 0.85)
    orm = np.stack([np.ones_like(rough), rough, metal], -1)
    Image.fromarray((orm * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, "orm.png"), optimize=True)
    names = []
    for name, (plates, suit, glow_color) in variants.items():
        plates = np.asarray(plates, np.float32); suit = np.asarray(suit, np.float32)
        tint = suit + (plates - suit) * np.clip(lum, 0, 1)[..., None] ** 0.8
        base = tint * (0.55 + 0.45 * team[..., None]) + diffuse * 0.12 * (1.0 - team[..., None])
        base = np.clip(base * (0.75 + 0.5 * lum[..., None]), 0, 1)
        Image.fromarray((np.power(base, 1 / 1.0) * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, "%s_base.png" % name), optimize=True)
        emit = np.clip(glow[..., None] * (lum[..., None] > 0.02) * np.asarray(glow_color, np.float32), 0, 1)
        Image.fromarray((emit * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, "%s_emit.png" % name), optimize=True)
        names.append(name)
    return names


def compile_re_soldier(data_dir, out_root, ident, model_rel):
    src = os.path.join(data_dir, "actors", "player")
    out_dir = os.path.join(out_root, "characters", ident)
    os.makedirs(out_dir, exist_ok=True)
    model = IQM(os.path.join(src, model_rel))
    pos = model.arrays[POSITION].astype(np.float64)
    nrm = model.arrays[NORMAL].astype(np.float64)
    uv = model.arrays[TEXCOORD].astype(np.float32).copy()
    uv[:, 1] = 1.0 - uv[:, 1]  # IQM/MD5 UVs are top-down; BlendEngine uses Blender's bottom-up V
    bi = model.arrays[BLENDINDEXES].astype(np.uint8)
    bw = model.arrays[BLENDWEIGHTS].astype(np.uint8)
    tris = model.triangles.astype(np.uint32)

    # Model space -> metres, facing -Y (Red Eclipse models face +X with mdlyaw -90).
    height = pos[:, 2].max() - pos[:, 2].min()
    scale = TARGET_HEIGHT / height
    joints = model.joints
    n = len(joints)
    parents = [j["parent"] for j in joints]

    # Bind pose in model space (IQM joints are relative to their parent).
    bind = [None] * n
    for i, j in enumerate(joints):
        local = trs_matrix(j["t"], j["r"], j["s"])
        bind[i] = local if parents[i] < 0 else bind[parents[i]] @ local
    # Root correction applied to everything: uniform scale and a yaw so the model faces -Y.
    root = np.eye(4)
    root[:3, :3] *= scale
    # The raw mesh faces -Y already when the toes point to -Y; detect from toe joints.
    names = [j["name"] for j in joints]
    toe = names.index("toe.L") if "toe.L" in names else None
    foot = names.index("foot.L") if "foot.L" in names else None
    yaw = 0.0
    if toe is not None and foot is not None:
        d = bind[toe][:3, 3] - bind[foot][:3, 3]
        yaw = math.atan2(-d[0], d[1])  # rotate so the toes point to +Y (the runtime's forward)
    c, s = math.cos(-yaw), math.sin(-yaw)
    rot = np.array([[c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
    root = rot @ root

    pos_m = (root[:3, :3] @ pos.T).T + root[:3, 3]
    nrm_m = (rot[:3, :3] @ nrm.T).T
    nrm_m /= np.maximum(np.linalg.norm(nrm_m, axis=1, keepdims=True), 1e-8)

    # Joint local transforms of the root joints carry the root correction.
    root_q = np.array([0, 0, math.sin(-yaw / 2), math.cos(-yaw / 2)], np.float32)

    def fix_root(trs, j):
        # trs: (..., 10) t, q, s for joint j; apply root (scale + yaw) to parentless joints.
        out = trs.copy()
        if parents[j] < 0:
            t = quat_rotate(np.broadcast_to(root_q, trs[..., 3:7].shape), trs[..., 0:3] * scale)
            out[..., 0:3] = t
            out[..., 3:7] = quat_mul(np.broadcast_to(root_q, trs[..., 3:7].shape), trs[..., 3:7])
        else:
            out[..., 0:3] = trs[..., 0:3] * scale
        return out

    bind_local = np.array([list(j["t"]) + list(j["r"]) + list(j["s"]) for j in joints], np.float32)
    bind_local = np.stack([fix_root(bind_local[i], i) for i in range(n)])
    # Inverse bind matrices from the corrected (metre, +Y facing) bind pose.
    bind_fixed = [None] * n
    for i in range(n):
        b = bind_local[i]
        local = trs_matrix(b[0:3], b[3:7], b[7:10])
        bind_fixed[i] = local if parents[i] < 0 else bind_fixed[parents[i]] @ local
    inv_bind = np.stack([np.linalg.inv(b) for b in bind_fixed]).astype(np.float32)

    blob = Blob()
    mesh = {
        "vertexCount": int(len(pos_m)),
        "position": blob.add(pos_m.astype(np.float32)),
        "normal": blob.add(nrm_m.astype(np.float32)),
        "uv": blob.add(uv),
        "joints": blob.add(bi),
        "weights": blob.add(bw),
        "indexType": "uint16" if len(pos_m) < 65536 else "uint32",
    }
    idx = tris.reshape(-1)
    mesh["index"] = blob.add(idx.astype(np.uint16 if len(pos_m) < 65536 else np.uint32))
    mesh["indexCount"] = int(len(idx))
    lo, hi = pos_m.min(0), pos_m.max(0)
    mesh["boundsMin"] = lo.tolist(); mesh["boundsMax"] = hi.tolist()

    clips = {}
    for name, (fname, fps, loop) in RE_CLIPS.items():
        path = os.path.join(src, fname)
        if not os.path.isfile(path):
            continue
        anim = IQM(path)
        frames = anim.frame_trs()
        if frames.shape[1] != n:
            print("skip clip", name, "joint count", frames.shape[1])
            continue
        frames = np.stack([fix_root(frames[:, j, :], j) for j in range(n)], 1)
        # Store t(3) q(4) uniform scale(1).
        packed = np.concatenate([frames[..., 0:7], frames[..., 7:8]], -1).astype(np.float32)
        clips[name] = {"fps": fps, "frames": int(frames.shape[0]), "loop": loop, "offset": blob.add(packed)}

    upper_root = names.index("ribs")
    upper = [False] * n
    for i in range(n):
        k = i
        while k >= 0:
            if k == upper_root:
                upper[i] = True
                break
            k = parents[k]

    skin_dir = os.path.join(out_root, "characters", "re_soldier_skin")
    os.makedirs(skin_dir, exist_ok=True)
    if not os.path.isfile(os.path.join(skin_dir, "orm.png")):
        bake_textures(src, skin_dir, VARIANTS)
    variants = list(VARIANTS)
    info = {
        "format": "BlendEngineCharacter", "version": 1, "id": ident,
        "source": "Red Eclipse 1.6 player model (actors/player/%s)" % model_rel,
        "license": "CC-BY-SA 3.0, Red Eclipse Team (redeclipse.net)",
        "joints": [{"name": names[i], "parent": parents[i]} for i in range(n)],
        "bindLocal": blob.add(bind_local.astype(np.float32)),
        "inverseBind": blob.add(np.ascontiguousarray(inv_bind.transpose(0, 2, 1)).astype(np.float32)),  # column major
        "upperBody": [i for i in range(n) if upper[i]],
        "mesh": mesh,
        "clips": clips,
        "sockets": {
            "weapon": {"joint": "hand.R", "offset": [0.1 * scale, -0.9 * scale, 0.1 * scale], "rotation": [-90, 0, -90]},
            "head": {"joint": "head", "offset": [0, -0.65 * scale, 0.5 * scale], "radius": 0.15},
        },
        "textures": {"normal": "../re_soldier_skin/normal.png", "orm": "../re_soldier_skin/orm.png"},
        "variants": {v: {"base": "../re_soldier_skin/%s_base.png" % v, "emit": "../re_soldier_skin/%s_emit.png" % v} for v in variants},
        "height": TARGET_HEIGHT,
        "scale": scale,
    }
    with open(os.path.join(out_dir, "character.bin"), "wb") as handle:
        handle.write(bytes(blob.data))
    with open(os.path.join(out_dir, "character.json"), "w") as handle:
        json.dump(info, handle, indent=1)
    print("%s: %d verts, %d tris, %d joints, %d clips, yaw %.1f deg, %.1f KB" % (ident, len(pos_m), len(tris), n, len(clips), math.degrees(yaw), len(blob.data) / 1024))


def parse_md5mesh(path):
    """Return (joints, meshes) of an MD5 mesh; meshes hold bind positions, uvs, triangles."""
    tokens_lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    joints, meshes, i = [], [], 0
    while i < len(tokens_lines):
        line = tokens_lines[i].strip()
        if line.startswith("joints {"):
            i += 1
            while not tokens_lines[i].strip().startswith("}"):
                raw = tokens_lines[i].split("//")[0].replace("(", " ").replace(")", " ").split()
                if raw:
                    name = raw[0].strip('"'); parent = int(raw[1])
                    p = np.array([float(v) for v in raw[2:5]]); q = [float(v) for v in raw[5:8]]
                    w2 = 1.0 - sum(v * v for v in q)
                    joints.append({"name": name, "parent": parent, "pos": p, "q": np.array(q + [-math.sqrt(max(w2, 0.0))])})
                i += 1
        elif line.startswith("mesh {"):
            verts, tris, weights = [], [], []
            i += 1
            while not tokens_lines[i].strip().startswith("}"):
                raw = tokens_lines[i].split("//")[0].replace("(", " ").replace(")", " ").split()
                if raw and raw[0] == "vert":
                    verts.append((float(raw[2]), float(raw[3]), int(raw[4]), int(raw[5])))
                elif raw and raw[0] == "tri":
                    tris.append((int(raw[2]), int(raw[3]), int(raw[4])))
                elif raw and raw[0] == "weight":
                    weights.append((int(raw[2]), float(raw[3]), np.array([float(v) for v in raw[4:7]])))
                i += 1
            pos = np.zeros((len(verts), 3)); uv = np.zeros((len(verts), 2), np.float32)
            for k, (u, v, start, count) in enumerate(verts):
                uv[k] = (u, 1.0 - v)
                for w in weights[start:start + count]:
                    j = joints[w[0]]
                    pos[k] += w[1] * (j["pos"] + quat_rotate(j["q"], w[2]))
            meshes.append({"pos": pos, "uv": uv, "tris": np.array(tris, np.uint32)})
        i += 1
    return joints, meshes


# Weapon id -> (mesh file, textures (base, normal, mask, glow), length in metres)
WEAPONS = {
    "rifle": ("rifle/rifle.md5mesh", ("rifle/skin.png", "rifle/norm.png", "rifle/mask.png", None), 1.02),
    "smg": ("smg/smg.md5mesh", ("smg/diffuse.png", "smg/normals.png", "smg/mask.png", None), 0.66),
    "shotgun": ("shotgun/shotgun-item.md5mesh", ("shotgun/skin.png", "shotgun/norm.png", "shotgun/mask.png", None), 0.98),
    "pistol": ("pistol/pistol-item.md5mesh", ("pistol/skin.png", "pistol/norm.png", None, "pistol/glow.png"), 0.24),
}


def compile_weapon(data_dir, out_root, ident):
    rel, (base, normal, mask, glow), length = WEAPONS[ident]
    src = os.path.join(data_dir, "weapons")
    joints, meshes = parse_md5mesh(os.path.join(src, rel))
    meshes = [m for m in meshes if len(m["tris"]) > 4]
    pos = np.concatenate([m["pos"] for m in meshes]); uv = np.concatenate([m["uv"] for m in meshes])
    tris, off = [], 0
    for m in meshes:
        tris.append(m["tris"] + off); off += len(m["pos"])
    tris = np.concatenate(tris)
    # MD5 triangles wind clockwise; flip to counter-clockwise.
    tris = tris[:, [0, 2, 1]]
    names = [j["name"] for j in joints]
    handle = joints[names.index("tag_handle")]["pos"] if "tag_handle" in names else np.zeros(3)
    muzzle = joints[names.index("tag_muzzle")]["pos"] if "tag_muzzle" in names else pos[np.argmax(pos[:, 0])]
    # Canonical frame: grip at the origin, barrel along +Y, up +Z, real-world length.
    axis = muzzle - handle
    span = pos[:, 0].max() - pos[:, 0].min()
    scale = length / max(span, 1e-6)
    rot = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1]], np.float64)  # +X -> +Y
    p = ((pos - handle) * scale) @ rot.T
    muzzle_m = ((muzzle - handle) * scale) @ rot.T
    if axis[0] < 0:
        p[:, 0:2] *= -1; muzzle_m[0:2] *= -1
    # Smooth normals.
    nrm = np.zeros_like(p)
    fn = np.cross(p[tris[:, 1]] - p[tris[:, 0]], p[tris[:, 2]] - p[tris[:, 0]])
    for k in range(3):
        np.add.at(nrm, tris[:, k], fn)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-9)
    out_dir = os.path.join(out_root, "weapons", ident)
    os.makedirs(out_dir, exist_ok=True)
    blob = Blob()
    mesh = {"vertexCount": int(len(p)), "position": blob.add(p.astype(np.float32)), "normal": blob.add(nrm.astype(np.float32)),
            "uv": blob.add(uv.astype(np.float32)), "indexType": "uint16", "index": blob.add(tris.reshape(-1).astype(np.uint16)),
            "indexCount": int(tris.size), "boundsMin": p.min(0).tolist(), "boundsMax": p.max(0).tolist()}
    img = Image.open(os.path.join(src, base)).convert("RGB")
    img.save(os.path.join(out_dir, "base.png"), optimize=True)
    Image.open(os.path.join(src, normal)).convert("RGB").save(os.path.join(out_dir, "normal.png"), optimize=True)
    if mask:
        m = np.asarray(Image.open(os.path.join(src, mask)).convert("RGB"), np.float32) / 255.0
        spec, glow_ch = m[..., 0], m[..., 1]
    else:
        spec = np.full(img.size[::-1], 0.5, np.float32); glow_ch = np.zeros_like(spec)
    rough = np.clip(0.7 - spec * 0.5, 0.2, 0.9); metal = np.clip(spec * 0.9, 0.1, 0.9)
    Image.fromarray((np.stack([np.ones_like(rough), rough, metal], -1) * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, "orm.png"), optimize=True)
    emit = np.asarray(Image.open(os.path.join(src, glow)).convert("RGB"), np.float32) / 255.0 if glow else glow_ch[..., None] * np.array([0.3, 0.8, 1.0], np.float32)
    Image.fromarray((np.clip(emit, 0, 1) * 255 + 0.5).astype(np.uint8)).save(os.path.join(out_dir, "emit.png"), optimize=True)
    info = {"format": "BlendEngineWeapon", "version": 1, "id": ident, "license": "CC-BY-SA 3.0, Red Eclipse Team (redeclipse.net)",
            "source": "Red Eclipse 1.6 weapons/%s" % rel, "mesh": mesh, "muzzle": muzzle_m.tolist(), "length": length,
            "textures": {"base": "base.png", "normal": "normal.png", "orm": "orm.png", "emit": "emit.png"}}
    with open(os.path.join(out_dir, "weapon.bin"), "wb") as handle_:
        handle_.write(bytes(blob.data))
    with open(os.path.join(out_dir, "weapon.json"), "w") as handle_:
        json.dump(info, handle_, indent=1)
    print("weapon %s: %d verts %d tris, muzzle %s" % (ident, len(p), len(tris), np.round(muzzle_m, 3)))


def main():
    data_dir, out_root = sys.argv[1], sys.argv[2]
    compile_re_soldier(data_dir, out_root, "re_soldier_male", "male/RE_Player_male.iqm")
    compile_re_soldier(data_dir, out_root, "re_soldier_female", "female/RE_Player_female.iqm")
    for ident in WEAPONS:
        compile_weapon(data_dir, out_root, ident)
    lic = os.path.join(data_dir, "actors", "cc-by-sa.txt")
    if os.path.isfile(lic):
        shutil.copyfile(lic, os.path.join(out_root, "characters", "LICENSE-CC-BY-SA-3.0.txt"))


if __name__ == "__main__":
    main()
