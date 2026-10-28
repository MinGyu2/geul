from hashlib import sha256
from pathlib import Path
import os
import sys

root = Path(sys.argv[1]).resolve()
digest = sha256()
count = 0
for parent, dirs, names in os.walk(root):
    dirs[:] = sorted(d for d in dirs if d not in {".git", "target", "pkg", "node_modules"})
    for name in sorted(names):
        path = Path(parent, name)
        relative = path.relative_to(root).as_posix().encode()
        digest.update(relative + b"\0")
        if path.is_symlink():
            digest.update(b"L" + os.readlink(path).encode())
        elif path.is_file():
            digest.update(b"F" + sha256(path.read_bytes()).digest())
        else:
            continue
        count += 1
print(digest.hexdigest(), count)
