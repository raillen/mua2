"""Load the vendored IGZ parser without running the Blender add-on's bpy imports."""
import os
from pathlib import Path
import sys
import types

ROOT = Path(__file__).resolve().parents[2]
VENDOR = Path(os.environ.get('IGB_SOURCE', ROOT / 'tools-vendor/igb-blender'))
if not (VENDOR / 'igz_format/igz_reader.py').is_file():
    raise ImportError(f'IGZ parser missing: {VENDOR}; clone igb-blender there or set IGB_SOURCE')
package = types.ModuleType('igb_blender')
package.__path__ = [str(VENDOR)]
sys.modules.setdefault('igb_blender', package)
