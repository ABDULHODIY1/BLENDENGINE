# SPDX-License-Identifier: GPL-2.0-or-later
#
# Compiles static props (trees, bushes, rocks, barrels, crates) and surface
# textures into BlendEngine assets:
#
#   python3 compile_props.py <redeclipse data dir> <addon assets dir>
#
#   assets/props/<id>/prop.json + prop.bin   surfaces with material slots
#   assets/textures/<name>.png (+ _n.png)    tiling surface textures with normal maps
#
# Props are converted to metres (Z up, real-world sizes listed below).
# Requires numpy and Pillow.

import json
import os
import shutil
import struct
import sys

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from compile_character_assets import Blob  # noqa: E402

LICENSE = "CC-BY-SA 3.0, Red Eclipse Team and contributors (redeclipse.net)"

# id -> (model, format, {surface: (texture, normal, kind)}, height in metres)
# kind: 'opaque', 'foliage' (alpha tested, two sided, wind) or 'bark'.
PROPS = {
    "tree_pine": ("vegetation/tree03/tris.md3", "md3", {"bark": ("vegetation/skin_evergreen.png", "vegetation/skin_evergreen_n.jpg", "bark"), "leaves": ("vegetation/skin_evergreen.png", "vegetation/skin_evergreen_n.jpg", "foliage")}, 11.0),
    "tree_oak": ("vegetation/tree09/tris.md3", "md3", {"bark": ("vegetation/skin_green3.png", "vegetation/skin_green3_n.jpg", "bark"), "leaves": ("vegetation/skin_green3.png", "vegetation/skin_green3_n.jpg", "foliage")}, 9.0),
    "tree_broad": ("vegetation/tree04/tris.md3", "md3", {"bark": ("vegetation/skin_green1.png", "vegetation/skin_green1_n.jpg", "bark"), "leaves": ("vegetation/skin_green1.png", "vegetation/skin_green1_n.jpg", "foliage")}, 12.0),
    "tree_birch": ("vegetation/tree05/tris.md3", "md3", {"bark": ("vegetation/skin_green4.png", "vegetation/skin_green4_n.jpg", "bark"), "leaves": ("vegetation/skin_green4.png", "vegetation/skin_green4_n.jpg", "foliage")}, 8.0),
    "tree_dry": ("vegetation/tree00/tris.md3", "md3", {"bark": ("vegetation/skin_dieing.png", "vegetation/skin_dieing_n.jpg", "bark"), "leaves": ("vegetation/skin_dieing.png", "vegetation/skin_dieing_n.jpg", "foliage")}, 9.5),
    "tree_dead": ("vegetation/tree02/tris.md3", "md3", {"*": ("vegetation/skin_dead.jpg", "vegetation/skin_dead_n.jpg", "bark")}, 7.0),
    "bush": ("vegetation/bush01/tris.md3", "md3", {"*": ("vegetation/skin_bush1.png", "vegetation/skin_bush1_n.jpg", "foliage")}, 1.4),
    "weeds": ("vegetation/tree07/tris.md3", "md3", {"*": ("vegetation/skin_weed1.png", "vegetation/skin_weed1_n.jpg", "foliage")}, 0.9),
    "rock_a": ("unnamed/rocks/rock01/rock01.obj", "obj", {"*": ("unnamed/stone01-a.png", "unnamed/stone01-a_n.png", "opaque")}, 1.6),
    "rock_b": ("unnamed/rocks/rock02/rock02.obj", "obj", {"*": ("unnamed/stone01-a.png", "unnamed/stone01-a_n.png", "opaque")}, 2.2),
    "barrel": ("jojo/barrel01/tris.obj", "obj", {"*": ("jojo/barrel01/skin.png", "jojo/barrel01/normal.png", "opaque")}, 1.0),
    "gas_tank": ("nobiax/gaz_tank/gaz.obj", "obj", {"*": ("nobiax/gaz_tank/diffus.png", "nobiax/gaz_tank/normal.png", "opaque")}, 1.3),
    "pallet": ("nobiax/pallet2/model.obj", "obj", {"*": ("nobiax/pallet2/diffuse.png", "nobiax/pallet2/normal.png", "opaque")}, 0.15),
    "cardboard_box": ("nobiax/cardboardbox1/model.obj", "obj", {"*": ("nobiax/cardboardbox1/diffus.png", "nobiax/cardboardbox1/normal.png", "opaque")}, 0.45),
}

# Tiling surface textures: name -> (base, normal)
TEXTURES = {
    "grass_lush": ("jojo/grass07.png", "jojo/grass07_n.png"),
    "grass_dry": ("jojo/grass01.png", "jojo/grass01_n.png"),
    "dirt": ("unnamed/stone01-a.png", "unnamed/stone01-a_n.png"),
    "rock_red": ("jojo/redrock01.png", "jojo/redrock01_n.png"),
    "gravel": ("jojo/debris01.png", "jojo/debris01_n.png"),
    "sand": ("jojo/sand01.png", "jojo/sand01_n.png"),
    "brick_painted": ("jojo/paintedbrick01.png", "jojo/paintedbrick01_n.png"),
    "brick_block": ("unnamed/brick01.png", "unnamed/brick01_n.png"),
    "concrete_tiles": ("jojo/concrete04.png", "jojo/concrete04_n.png"),
    "concrete_stripes": ("jojo/concrete09.png", "jojo/concrete09_n.png"),
    "crate": ("trak/trak5/crate1a.jpg", None),
}


def decode_normal(lat_lng):
    lat = ((lat_lng >> 8) & 255) * (2 * np.pi / 255.0)
    lng = (lat_lng & 255) * (2 * np.pi / 255.0)
    return np.stack([np.cos(lat) * np.sin(lng), np.sin(lat) * np.sin(lng), np.cos(lng)], -1)


def read_md3(path):
    data = open(path, "rb").read()
    ident, version = struct.unpack_from("<4si", data, 0)
    assert ident == b"IDP3", path
    num_frames, num_tags, num_surfaces, num_skins, ofs_frames, ofs_tags, ofs_surfaces, ofs_end = struct.unpack_from("<8i", data, 76)
    surfaces, off = [], ofs_surfaces
    for _ in range(num_surfaces):
        sid, sname, sflags, s_frames, s_shaders, s_verts, s_tris, ofs_tris, ofs_shaders, ofs_st, ofs_xyz, ofs_send = struct.unpack_from("<4s64s10i", data, off)
        name = sname.split(b"\0")[0].decode()
        tris = np.frombuffer(data, np.int32, s_tris * 3, off + ofs_tris).reshape(-1, 3)
        st = np.frombuffer(data, np.float32, s_verts * 2, off + ofs_st).reshape(-1, 2).copy()
        xyzn = np.frombuffer(data, np.int16, s_verts * 4, off + ofs_xyz).reshape(-1, 4)
        pos = xyzn[:, :3].astype(np.float64) / 64.0
        nrm = decode_normal(xyzn[:, 3].astype(np.int32) & 0xFFFF)
        st[:, 1] = 1.0 - st[:, 1]
        surfaces.append({"name": name, "pos": pos, "nrm": nrm, "uv": st, "tris": tris[:, [0, 2, 1]].astype(np.uint32)})
        off += ofs_send
    return surfaces


def read_obj(path):
    verts, uvs, norms, faces = [], [], [], []
    group = "*"
    groups = {}
    for line in open(path, encoding="utf-8", errors="replace"):
        p = line.split()
        if not p:
            continue
        if p[0] == "v":
            verts.append([float(v) for v in p[1:4]])
        elif p[0] == "vt":
            uvs.append([float(p[1]), float(p[2])])
        elif p[0] == "vn":
            norms.append([float(v) for v in p[1:4]])
        elif p[0] in ("g", "o", "usemtl") and len(p) > 1 and p[0] != "o":
            group = p[1]
        elif p[0] == "f":
            idx = [tuple(int(x) if x else 0 for x in (c.split("/") + ["", ""])[:3]) for c in p[1:]]
            for k in range(1, len(idx) - 1):
                groups.setdefault(group, []).append((idx[0], idx[k], idx[k + 1]))
    verts = np.array(verts); uvs = np.array(uvs) if uvs else np.zeros((1, 2)); norms = np.array(norms) if norms else None
    surfaces = []
    for name, tris in groups.items():
        remap, pos, uv, nrm, out = {}, [], [], [], []
        for tri in tris:
            for v in tri:
                key = v
                if key not in remap:
                    remap[key] = len(pos)
                    pos.append(verts[v[0] - 1 if v[0] > 0 else v[0]])
                    uv.append(uvs[v[1] - 1] if v[1] else [0, 0])
                    nrm.append(norms[v[2] - 1] if (norms is not None and v[2]) else [0, 0, 1])
                out.append(remap[key])
        pos = np.array(pos, np.float64)
        # OBJ files are Y up: convert to Z up.
        pos = np.stack([pos[:, 0], -pos[:, 2], pos[:, 1]], -1)
        nrm = np.array(nrm, np.float64); nrm = np.stack([nrm[:, 0], -nrm[:, 2], nrm[:, 1]], -1)
        surfaces.append({"name": name, "pos": pos, "nrm": nrm, "uv": np.array(uv, np.float32), "tris": np.array(out, np.uint32).reshape(-1, 3)})
    return surfaces


def copy_texture(src, dst, max_size=1024, keep_alpha=False):
    im = Image.open(src)
    im = im.convert("RGBA" if keep_alpha and im.mode in ("RGBA", "LA", "P") else "RGB")
    if max(im.size) > max_size:
        im = im.resize((max_size, max_size * im.size[1] // im.size[0]), Image.LANCZOS)
    im.save(dst, optimize=True)


def compile_prop(data_dir, out_root, ident):
    rel, fmt, skins, height = PROPS[ident]
    surfaces = read_md3(os.path.join(data_dir, rel)) if fmt == "md3" else read_obj(os.path.join(data_dir, rel))
    allpos = np.concatenate([s["pos"] for s in surfaces])
    lo, hi = allpos.min(0), allpos.max(0)
    scale = height / max(hi[2] - lo[2], 1e-6)
    origin = np.array([(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]])
    out_dir = os.path.join(out_root, "props", ident)
    tex_dir = os.path.join(out_root, "props", "textures")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(tex_dir, exist_ok=True)
    blob = Blob()
    out_surfaces = []
    for s in surfaces:
        base, normal, kind = skins.get(s["name"], skins.get("*", next(iter(skins.values()))))
        tex = {}
        for key, src in (("base", base), ("normal", normal)):
            name = os.path.splitext(src.replace("/", "_"))[0] + ".png"
            dst = os.path.join(tex_dir, name)
            if not os.path.isfile(dst):
                copy_texture(os.path.join(data_dir, src), dst, keep_alpha=(key == "base"))
            tex[key] = "../textures/" + name
        p = (s["pos"] - origin) * scale
        n = s["nrm"] / np.maximum(np.linalg.norm(s["nrm"], axis=1, keepdims=True), 1e-9)
        out_surfaces.append({
            "name": s["name"], "kind": kind, "vertexCount": int(len(p)),
            "position": blob.add(p.astype(np.float32)), "normal": blob.add(n.astype(np.float32)), "uv": blob.add(s["uv"].astype(np.float32)),
            "index": blob.add(s["tris"].reshape(-1).astype(np.uint32)), "indexCount": int(s["tris"].size), "textures": tex,
        })
    info = {"format": "BlendEngineProp", "version": 1, "id": ident, "source": "Red Eclipse 1.6 data/%s" % rel, "license": LICENSE,
            "height": height, "surfaces": out_surfaces}
    with open(os.path.join(out_dir, "prop.bin"), "wb") as h:
        h.write(bytes(blob.data))
    with open(os.path.join(out_dir, "prop.json"), "w") as h:
        json.dump(info, h, indent=1)
    print("prop %-14s %6d tris  %d surfaces  size %s m" % (ident, sum(s["indexCount"] for s in out_surfaces) // 3, len(out_surfaces), np.round((hi - lo) * scale, 2)))


def main():
    data_dir, out_root = sys.argv[1], sys.argv[2]
    for ident in PROPS:
        compile_prop(data_dir, out_root, ident)
    tdir = os.path.join(out_root, "textures")
    os.makedirs(tdir, exist_ok=True)
    for name, (base, normal) in TEXTURES.items():
        copy_texture(os.path.join(data_dir, base), os.path.join(tdir, name + ".png"))
        if normal:
            copy_texture(os.path.join(data_dir, normal), os.path.join(tdir, name + "_n.png"))
    for folder in ("props", "textures"):
        with open(os.path.join(out_root, folder, "LICENSE.txt"), "w") as h:
            h.write("Assets from Red Eclipse 1.6 (redeclipse.net): %s.\nhttp://creativecommons.org/licenses/by-sa/3.0/\n" % LICENSE)
    print("textures:", ", ".join(TEXTURES))


if __name__ == "__main__":
    main()
