"""Import owned Collada vegetation into backend-neutral, block-local triangles.

Offline asset ingestion only: runtime/builds consume data/models/*.json and do
not require Python, Collada, the original atlas, or the reference checkout.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import xml.etree.ElementTree as ET

NS = {"c": "http://www.collada.org/2005/11/COLLADASchema"}
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def product(a, b):
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
            for r in range(4) for c in range(4)]


def transform(matrix, point, direction=False):
    p = [*point, 0 if direction else 1]
    return [sum(matrix[r * 4 + k] * p[k] for k in range(4)) for r in range(3)]


def import_mesh(path, mesh_name, default_slot, surface_color):
    root = ET.parse(path).getroot()
    geometry = next(g for g in root.findall(".//c:geometry", NS) if g.get("name") == mesh_name)
    transforms = {}

    def visit(node, parent):
        matrix = node.find("c:matrix", NS)
        local = IDENTITY if matrix is None else list(map(float, matrix.text.split()))
        combined = product(parent, local)
        for instance in node.findall("c:instance_geometry", NS):
            transforms[instance.get("url")[1:]] = combined
        for child in node.findall("c:node", NS):
            visit(child, combined)

    for node in root.findall(".//c:visual_scene/c:node", NS):
        visit(node, IDENTITY)
    matrix = transforms[geometry.get("id")]
    sources = {}
    for source in geometry.findall("c:mesh/c:source", NS):
        accessor = source.find("c:technique_common/c:accessor", NS)
        sources[source.get("id")] = (list(map(float, source.find("c:float_array", NS).text.split())), int(accessor.get("stride")))
    vertices = geometry.find("c:mesh/c:vertices/c:input", NS).get("source")[1:]
    triangles = []
    for group in geometry.findall("c:mesh/c:triangles", NS):
        inputs = {i.get("semantic"): (vertices if i.get("semantic") == "VERTEX" else i.get("source")[1:], int(i.get("offset"))) for i in group.findall("c:input", NS)}
        stride = max(i[1] for i in inputs.values()) + 1
        indices = list(map(int, group.find("c:p", NS).text.split()))
        assert len(indices) == int(group.get("count")) * 3 * stride
        for start in range(0, len(indices), 3 * stride):
            output = []
            triangle_slot = None
            for vertex in range(3):
                def read(semantic):
                    source, offset = inputs[semantic]
                    values, size = sources[source]
                    index = indices[start + vertex * stride + offset] * size
                    return values[index:index + size]

                position = transform(matrix, read("VERTEX"))
                normal = transform(matrix, read("NORMAL"), True)
                length = math.sqrt(sum(v * v for v in normal))
                normal = [v / length for v in normal]
                u, v = read("TEXCOORD")
                # Engine's Collada reader flips V once before any slot offset.
                v = 1 - v
                if mesh_name == "Starfish":
                    u += 15 / 16
                    v += 3 / 16
                slot_x, slot_y = int(u * 16), int(v * 16)
                slot = slot_x + slot_y * 16
                assert triangle_slot in (None, slot), "A triangle crosses a texture tile"
                triangle_slot = slot
                position[0] += 0.5
                position[2] += 0.5
                if mesh_name in ("Starfish", "Urchin"):
                    position[1] += 0.01
                output.extend(round(n, 7) for n in [*position, *normal, u * 16 - slot_x, v * 16 - slot_y])
            assert triangle_slot in (default_slot, 101) if mesh_name == "Cactus" else triangle_slot == default_slot
            triangles.append({"face": "top" if triangle_slot == 101 else "side", "vertices": output})
    assert triangles
    return {"schemaVersion": 1, "sourceHash": hashlib.sha256(path.read_bytes()).hexdigest(), "color": surface_color, "triangles": triangles}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("assets", type=Path)
    args = parser.parse_args()
    output = Path(__file__).resolve().parents[1] / "packages/client/rendering/data/models/vegetation"
    output.mkdir(parents=True, exist_ok=True)
    for name, file, mesh, slot, color in [
        ("cactus", "Cactus", "Cactus", 100, [1, 1, 1]),
        ("pumpkin", "Pumpkins", "Pumpkin", 102, [1, 1, 1]),
        ("starfish", "Starfish", "Starfish", 63, [0.392157, 0.156863, 0.078431]),
        ("sea-urchin", "SeaUrchin", "Urchin", 15, [0.156863, 0.156863, 0.156863]),
    ]:
        asset = import_mesh(args.assets / "Models" / (file + ".dae"), mesh, slot, color)
        (output / (name + ".json")).write_text(json.dumps(asset, separators=(",", ":")) + "\n")
        print(name, len(asset["triangles"]), "triangles")


if __name__ == "__main__":
    main()
