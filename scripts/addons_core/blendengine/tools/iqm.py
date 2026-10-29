# SPDX-License-Identifier: GPL-2.0-or-later
#
# Reader for Inter-Quake Model (IQM v2) files: skinned meshes, skeletons and
# animations. Used by compile_character_assets.py; needs only numpy.

import struct

import numpy as np

IQM_MAGIC = b"INTERQUAKEMODEL\0"
HEADER = struct.Struct("<16s27I")
FORMATS = {0: np.int8, 1: np.uint8, 2: np.int16, 3: np.uint16, 4: np.int32, 5: np.uint32, 6: np.float16, 7: np.float32, 8: np.float64}
POSITION, TEXCOORD, NORMAL, TANGENT, BLENDINDEXES, BLENDWEIGHTS, COLOR = range(7)


class IQM:
    def __init__(self, path):
        with open(path, "rb") as handle:
            data = handle.read()
        fields = HEADER.unpack_from(data, 0)
        if fields[0] != IQM_MAGIC or fields[1] != 2:
            raise ValueError("%s is not an IQM v2 file" % path)
        (self.version, filesize, flags, num_text, ofs_text, num_meshes, ofs_meshes, num_va, num_vertexes, ofs_va,
         num_triangles, ofs_triangles, ofs_adjacency, num_joints, ofs_joints, num_poses, ofs_poses, num_anims,
         ofs_anims, num_frames, num_framechannels, ofs_frames, ofs_bounds, num_comment, ofs_comment,
         num_extensions, ofs_extensions) = fields[1:]
        text = data[ofs_text:ofs_text + num_text]

        def name(offset):
            end = text.index(b"\0", offset)
            return text[offset:end].decode("utf-8", "replace")

        self.meshes = []
        for i in range(num_meshes):
            n, mat, fv, nv, ft, nt = struct.unpack_from("<6I", data, ofs_meshes + i * 24)
            self.meshes.append({"name": name(n), "material": name(mat), "first_vertex": fv, "num_vertexes": nv, "first_triangle": ft, "num_triangles": nt})
        self.arrays = {}
        for i in range(num_va):
            vtype, vflags, vformat, size, offset = struct.unpack_from("<5I", data, ofs_va + i * 20)
            dtype = FORMATS[vformat]
            arr = np.frombuffer(data, dtype=dtype, count=num_vertexes * size, offset=offset).reshape(num_vertexes, size)
            self.arrays[vtype] = arr.copy()
        self.triangles = np.frombuffer(data, dtype=np.uint32, count=num_triangles * 3, offset=ofs_triangles).reshape(-1, 3).copy() if num_triangles else np.zeros((0, 3), np.uint32)
        self.joints = []
        for i in range(num_joints):
            vals = struct.unpack_from("<Ii10f", data, ofs_joints + i * 48)
            self.joints.append({"name": name(vals[0]), "parent": vals[1], "t": vals[2:5], "r": vals[5:9], "s": vals[9:12]})
        self.poses = []
        for i in range(num_poses):
            vals = struct.unpack_from("<iI20f", data, ofs_poses + i * 88)
            self.poses.append({"parent": vals[0], "mask": vals[1], "offset": np.array(vals[2:12], np.float32), "scale": np.array(vals[12:22], np.float32)})
        self.anims = []
        for i in range(num_anims):
            n, first, count, rate, aflags = struct.unpack_from("<3IfI", data, ofs_anims + i * 20)
            self.anims.append({"name": name(n), "first_frame": first, "num_frames": count, "framerate": rate, "loop": bool(aflags & 1)})
        self.frames = np.frombuffer(data, dtype=np.uint16, count=num_frames * num_framechannels, offset=ofs_frames).reshape(num_frames, num_framechannels).astype(np.float32) if num_frames else None

    def frame_trs(self):
        """Per frame, per pose local transform: array (frames, poses, 10) = t xyz, r xyzw, s xyz."""
        if self.frames is None:
            return np.zeros((0, len(self.poses), 10), np.float32)
        out = np.zeros((self.frames.shape[0], len(self.poses), 10), np.float32)
        column = 0
        for p, pose in enumerate(self.poses):
            out[:, p, :] = pose["offset"]
            for c in range(10):
                if pose["mask"] & (1 << c):
                    out[:, p, c] += self.frames[:, column] * pose["scale"][c]
                    column += 1
        q = out[:, :, 3:7]
        q /= np.maximum(np.linalg.norm(q, axis=2, keepdims=True), 1e-8)
        return out
