#!/usr/bin/env python3
"""Read reflected Havok 6.1 64-bit LE packfiles; no native code execution."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import struct


class Packfile:
    def __init__(self, path):
        self.path = Path(path)
        self.data = self.path.read_bytes()
        assert self.data[:8] == bytes.fromhex('57e0e05710c0c010')
        assert self.unpack('I', 12)[0] == 6 and self.data[16:18] == b'\x08\x01'
        self.sections = []
        self.pointers = {}
        self.objects = {}
        for i in range(self.unpack('I', 20)[0]):
            p = 0x40 + i * 48
            name = self.string(p)
            start, local, glob, virt, exports, imports, end = self.unpack('7I', p + 20)
            assert start + end <= len(self.data)
            assert 0 <= local <= glob <= virt <= exports <= imports <= end
            self.sections.append(dict(name=name, start=start, local=local, glob=glob, virt=virt, exports=exports, end=end))
        for i, s in enumerate(self.sections):
            base = s['start']
            for p in range(base + s['local'], base + s['glob'] - 7, 8):
                src, dst = self.unpack('2I', p)
                if src == 0xffffffff:
                    break
                assert src < s['local'] and dst < s['local']
                self.pointers[base + src] = base + dst
            for p in range(base + s['glob'], base + s['virt'] - 11, 12):
                src, section, dst = self.unpack('3I', p)
                if src == 0xffffffff:
                    break
                assert src < s['local'] and section < len(self.sections)
                assert dst < self.sections[section]['local']
                self.pointers[base + src] = self.sections[section]['start'] + dst
            for p in range(base + s['virt'], base + s['exports'] - 11, 12):
                src, section, dst = self.unpack('3I', p)
                if src == 0xffffffff:
                    break
                self.objects[base + src] = self.string(self.sections[section]['start'] + dst)
        self.classes = {}
        for p, kind in self.objects.items():
            if kind != 'hkClass':
                continue
            name = self.string(self.pointer(p))
            members = []
            m = self.pointer(p + 40)
            count = self.unpack('I', p + 48)[0]
            for j in range(count):
                q = m + j * 40
                typ, sub, size, flags, offset = self.unpack('BBHHH', q + 24)
                members.append(dict(name=self.string(self.pointer(q)), type=typ, subtype=sub, size=size, flags=flags, offset=offset, class_address=self.pointer(q + 8)))
            parent = self.pointer(p + 8)
            self.classes[name] = dict(address=p, size=self.unpack('I', p + 16)[0], parent_address=parent, members=members)
        self.class_names = {c['address']: n for n, c in self.classes.items()}
        for c in self.classes.values():
            c['parent'] = self.class_names.get(c.pop('parent_address'))
            for m in c['members']:
                m['class'] = self.class_names.get(m.pop('class_address'))

    def unpack(self, fmt, p):
        return struct.unpack_from('<' + fmt, self.data, p)

    def pointer(self, p):
        return self.pointers.get(p)

    def string(self, p):
        if p is None:
            return None
        return self.data[p:self.data.index(0, p)].decode('utf8')

    def members(self, name):
        c = self.classes[name]
        return (self.members(c['parent']) if c['parent'] else []) + c['members']

    def fields(self, p, name=None):
        name = name or self.objects[p]
        return {m['name']: self.value(p + m['offset'], m) for m in self.members(name)}

    def value(self, p, m):
        t, sub = m['type'], m['subtype']
        fmts = {1:'B', 2:'b', 3:'b', 4:'B', 5:'h', 6:'H', 7:'i', 8:'I', 9:'q', 10:'Q', 11:'f', 12:'4f', 13:'4f', 16:'12f', 17:'16f', 18:'16f', 30:'Q'}
        if t in fmts:
            values = self.unpack(fmts[t], p)
            return values[0] if len(values) == 1 else list(values)
        if t in (29, 33):
            return self.string(self.pointer(p))
        if t == 25:
            return self.fields(p, m['class'])
        if t == 24:  # enum
            return self.value(p, dict(m, type=sub))
        if t in (22, 26):
            target = self.pointer(p)
            count = self.unpack('i', p + 8)[0]
            assert 0 <= count <= len(self.data)
            if count == 0:
                return []
            assert target is not None
            if sub == 22:
                stride = self.classes[m['class']]['size']
            elif sub in (20, 30, 33):
                stride = 8
            elif sub in fmts:
                stride = struct.calcsize('<' + fmts[sub])
            else:
                raise ValueError(('array subtype', sub, m))
            assert target + stride * count <= len(self.data)
            return [self.value(target + j * stride, dict(m, type=sub)) for j in range(count)]
        if t == 21:
            target = self.pointer(p)
            return {'address': target, 'class': self.objects.get(target, m['class'])} if target is not None else None
        if t == 0:
            return None
        raise ValueError(('type', t, m))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    hk = Packfile(args.input)
    result = dict(source=str(args.input), sha256=hashlib.sha256(hk.data).hexdigest(), sections=hk.sections, classes=hk.classes, objects=[dict(address=p, **{'class': c}, fields=hk.fields(p)) for p, c in hk.objects.items() if c != 'hkClass'])
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2))
    print(args.out)


if __name__ == '__main__':
    main()
