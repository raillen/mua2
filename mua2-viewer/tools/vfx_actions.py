#!/usr/bin/env python3
"""Derive authentic VFX action bindings from MUA2 combat and entity data.

Read powerstyles, fusion and fightstyles recursively, plus standalone entity
metadata, from a full ``data.bin`` extraction (or a legacy powerstyles folder).
Only explicit object references are followed; entity effects without a spawn
edge remain separate from action bindings.

Only data present in the game files is emitted: no effect is associated with a
character, clip, time or bone by guessing.  When an enum has no corresponding
exported clip the ``clip`` field is ``null`` and the enum is reported in
``unmappedEnums``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict
from typing import Any, Iterable

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from vfx_decode import CATALOG_FILENAME, load_effects_catalog

IGX_RE = re.compile(r'<igx\s+name="([^"]+)"', re.I)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DEFAULT_DATA_BIN = os.path.join(ROOT, '_work', 'extracted', 'data.bin')
DEFAULT_MUA2BIN = os.path.join(ROOT, 'mua2-viewer', 'tools', 'mua2bin')
DEFAULT_OUT = os.path.join(ROOT, 'mua2-viewer', 'assets', 'vfx', 'action_map.json')
DEFAULT_CATALOG = os.path.join(ROOT, 'mua2-viewer', 'assets', 'vfx', CATALOG_FILENAME)
DEFAULT_MODELS = os.path.join(ROOT, 'mua2-viewer', 'assets', 'models', 'models.json')
DEFAULT_ANIM_INDEX = os.path.join(ROOT, 'mua2-viewer', 'assets', 'animations', 'index.json')
DEFAULT_ANIM_DIR = os.path.join(ROOT, 'mua2-viewer', 'assets', 'animations')

# The powerstyle file name is not always the character key used by the VFX
# catalog (legacy spelling and boss/hero variants).  These aliases are literal
# game names, not guesses.
PS_ALIASES = {
    'fury': 'nickfury',
    'nickfuryhero': 'nickfury',
    'nanitenickfury': 'nickfury',
    'moltonman': 'moltenman',
    'thing': 'thething',
    'vanbardos': 'luciavonbardas',
    'cablehero': 'cable',
    'blackpantherhero': 'blackpanther',
    'bphero': 'blackpanther',
    'captainamericaboss': 'captainamerica',
    'capambient': 'captainamerica',
    'deadpoolminiboss': 'deadpool',
    'venomwakmb': 'venom',
    'ironmanboss': 'ironman',
    'bishopboss': 'bishop',
    'greengoblinwakmb': 'greengoblin',
    'carnageminiboss': 'carnage',
    'ironfistminiboss': 'ironfist',
    'lukecageminiboss': 'lukecage',
    'magnetominiboss': 'magneto',
    'songbirdminiboss': 'songbird',
    'warmachineboss': 'warmachine',
}

# Enum -> exported Havok clip.  Only semantically identical names are listed;
# every other enum is resolved by normalized name or stays null.
EA_CLIP_ALIASES = {
    'EA_IDLE1': 'idle',
    'EA_RUN1': 'run',
    'EA_SPRINT1': 'run_sprint',
    'EA_WALK1': 'walk',
    'EA_ATTACK_GROUND1': 'ground_attack1',
    'EA_ATTACK_GROUND2': 'ground_attack2',
    'EA_ATTACK_JUMPSLAM': 'jump_smash',
    'EA_ATTACK_JUMPSLAMLAND': 'jump_land',
    'EA_ATTACK_JUMPSLAMLOOP': 'jump_smash_loop',
    'EA_ATTACK_POPUP': 'attack_popup1',
    'EA_EVADE_FORWARD': 'evade_forwardroll',
    'EA_GRAPPLE_START': 'grapple_attempt',
    'EA_GETUP_ON_BACK1': 'getup_back',
    'EA_GETUP_ON_FRONT1': 'getup_front',
    'EA_DOUBLE_JUMP_START': 'jumpdouble_start',
    'EA_JUMP_LOOP': 'jump_loop',
    'EA_GRAB_BREAK': 'grapple_break',
    'EA_BLOCKING': 'blocking',
}

# Bolt identifiers extracted from Alliance.exe.  ``candidates`` are ordered
# fallbacks for actors that do not ship every attachment bone.
BOLT_CANDIDATES: dict[str, list[str]] = {
    'EBOLT_LHAND': ['Bip01 L Hand'],
    'EBOLT_RHAND': ['Bip01 R Hand'],
    'EBOLT_LHANDATTACH': ['Bip01 L HandAttach', 'Bip01 L Hand'],
    'EBOLT_RHANDATTACH': ['Bip01 R HandAttach', 'Bip01 R Hand'],
    'EBOLT_TORSO': ['Bip01 Spine2', 'Bip01 Spine1', 'Bip01 Spine'],
    'EBOLT_LOWER_TORSO': ['Bip01 Spine', 'Bip01 Spine1', 'Bip01 Pelvis'],
    'EBOLT_PELVIS': ['Bip01 Pelvis'],
    'EBOLT_ROOT': ['Bip01'],
    'EBOLT_HEAD': ['Bip01 Head'],
    'EBOLT_NECK': ['Bip01 Neck'],
    'EBOLT_LFOOT': ['Bip01 L Foot'],
    'EBOLT_RFOOT': ['Bip01 R Foot'],
    'EBOLT_LFOOTATTACH01': ['Bip01 L FootAttach01', 'Bip01 L Foot'],
    'EBOLT_RFOOTATTACH01': ['Bip01 R FootAttach01', 'Bip01 R Foot'],
    'EBOLT_LFOREARM': ['Bip01 L Forearm'],
    'EBOLT_RFOREARM': ['Bip01 R Forearm'],
    'EBOLT_LFOREARMATTACH01': ['Bip01 L ForearmAttach01', 'Bip01 L Forearm'],
    'EBOLT_LFOREARMATTACH02': ['Bip01 L ForearmAttach02', 'Bip01 L ForearmAttach01', 'Bip01 L Forearm'],
    'EBOLT_RFOREARMATTACH': ['Bip01 R ForearmAttach', 'Bip01 R Forearm'],
    'EBOLT_RFOREARMATTACH01': ['Bip01 R ForearmAttach01', 'Bip01 R Forearm'],
    'EBOLT_LUPPERARM': ['Bip01 L UpperArm'],
    'EBOLT_RUPPERARM': ['Bip01 R UpperArm'],
    'EBOLT_LCLAVICLE': ['Bip01 L Clavicle'],
    'EBOLT_RCLAVICLE': ['Bip01 R Clavicle'],
    'EBOLT_LTHIGH': ['Bip01 L Thigh'],
    'EBOLT_RTHIGH': ['Bip01 R Thigh'],
    'EBOLT_LCALF': ['Bip01 L Calf'],
    'EBOLT_RCALF': ['Bip01 R Calf'],
    'EBOLT_LANKLE': ['Bip01 L Foot', 'Bip01 L Calf'],
    'EBOLT_RANKLE': ['Bip01 R Foot', 'Bip01 R Calf'],
    'EBOLT_LHIPATTACH': ['Bip01 L HipAttach', 'Bip01 Pelvis'],
    'EBOLT_RHIPATTACH': ['Bip01 R HipAttach', 'Bip01 Pelvis'],
    'EBOLT_LSHOULDERATTACH': ['Bip01 L ShoulderAttach', 'Bip01 L UpperArm'],
    'EBOLT_RSHOULDERATTACH': ['Bip01 R ShoulderAttach', 'Bip01 R UpperArm'],
    'EBOLT_CARRYATTACH': ['Bip01 CarryAttach', 'Bip01 R Hand'],
    'EBOLT_OBJECT_TRANSFORM': [],
    'EBOLT_ORIGIN': [],
    'EBOLT_NONE': [],
    'EBOLT_BOLTBASE': [],
    'EBOLT_BOLTEND': [],
    'EBOLT_SPECIAL1': ['Bip01 Spine2', 'Bip01 Spine'],
    'EBOLTON_WEAPON': ['Bip01 R HandAttach', 'Bip01 R Hand'],
    'EBOLTON_ALT_WEAPON': ['Bip01 R HandAttach', 'Bip01 R Hand'],
    'EBOLTON_ALT_WEAPON2': ['Bip01 R HandAttach', 'Bip01 R Hand'],
    'EBOLTON_ALT_WEAPON3': ['Bip01 R HandAttach', 'Bip01 R Hand'],
    'EBOLTON_ALT_WEAPON4': ['Bip01 R HandAttach', 'Bip01 R Hand'],
    'EBOLTON_ALT_WEAPON5': ['Bip01 R HandAttach', 'Bip01 R Hand'],
    'EBOLTON_CLAW_LEFT': ['Bip01 L HandAttach', 'Bip01 L Hand'],
    'EBOLTON_CLAW_RIGHT': ['Bip01 R HandAttach', 'Bip01 R Hand'],
    'EBOLTON_CAPE': ['Bip01 Spine2', 'Bip01 Spine'],
    'EBOLTON_HAIR': ['Bip01 Head'],
    'EBOLTON_TAIL': ['Bip01 Pelvis'],
    'EBOLTON_WINGS': ['Bip01 Spine2', 'Bip01 Spine'],
    'EBOLTON_NONE': [],
    'EBOLTON_MAX': [],
}
for _i in range(1, 14):
    BOLT_CANDIDATES[f'EBOLT_FX{_i:02d}'] = [f'fx{_i:02d}', 'Bip01 Spine2', 'Bip01 Spine']
for _i in range(1, 11):
    BOLT_CANDIDATES[f'EBOLT_BOLT{_i:02d}'] = [f'Bolt_{_i:02d}', 'Bip01 Spine2', 'Bip01 Spine']
for _i in range(1, 21):
    BOLT_CANDIDATES[f'EBOLT_FLOAT_{_i:02d}'] = ['Bip01 Spine2', 'Bip01 Spine']
for _i in range(1, 10):
    BOLT_CANDIDATES[f'EBOLT_FLOAT_O{_i}'] = ['Bip01 Spine2', 'Bip01 Spine']
for _i in range(10, 20):
    BOLT_CANDIDATES[f'EBOLT_FLOAT_{_i}'] = ['Bip01 Spine2', 'Bip01 Spine']
BOLT_CANDIDATES['EBOLT_FLOAT_1O'] = ['Bip01 Spine2', 'Bip01 Spine']
BOLT_CANDIDATES['EBOLT_FLOAT_20'] = ['Bip01 Spine2', 'Bip01 Spine']

ORIGIN_BOLTS = {
    'EBOLT_OBJECT_TRANSFORM', 'EBOLT_ORIGIN', 'EBOLT_NONE',
    'EBOLT_BOLTBASE', 'EBOLT_BOLTEND', 'EBOLTON_NONE', 'EBOLTON_MAX',
}

OBJECT_RE = re.compile(r'<object\s+refname="([^"]+)"[^>]*?type="([^"]+)"\s*(?:/>|>(.*?)</object>)', re.S)
VAR_RE = re.compile(r'<var\s+name="([^"]+)"\s+(?:(?:value="([^"]*)")|(?:ref="([^"]*)"))')
LIST_RE = re.compile(r'<listitem\s+ref="([^"]+)"')

PROP_SOURCE_RE = re.compile(r'(?:baton|bola|staff|chain|waldos|webmace|tongue|gambit_cards)', re.I)
SCENE_CHARACTERS = {'shared', 'sharedfusion', 'minion', 'nanite', 'naniteexp', 'coonspawn', 'grenade', 'hawk', 'krang', 'robotbomber', 'robotlarge'}
SUFFIXES = ('hero', 'boss', 'miniboss', 'wakmb')


# ---------------------------------------------------------------------------
# MUC parsing
# ---------------------------------------------------------------------------

def parse_objects(text: str) -> dict[str, dict[str, Any]]:
    """Parse every <object> in a .muc file.  Game names are case-insensitive."""
    objects: dict[str, dict[str, Any]] = {}
    for match in OBJECT_RE.finditer(text):
        refname, type_name, body = match.group(1), match.group(2), match.group(3) or ''
        variables: dict[str, str] = {}
        for var in VAR_RE.finditer(body):
            name = var.group(1)
            value = var.group(2) if var.group(2) is not None else '@' + var.group(3)
            variables[name] = value
        objects[refname.lower()] = {
            'refname': refname,
            'type': type_name,
            'vars': variables,
            'items': [item.lower() for item in LIST_RE.findall(body)],
        }
    return objects


def extract_namespace_and_aliases(text: str, objects: dict[str, Any]) -> tuple[str, dict[str, str]]:
    match = IGX_RE.search(text)
    aliases = {}
    for obj in objects.values():
        if obj['type'] == 'PeachesAlias':
            values = obj['vars']
            if values.get('_aliasName') and values.get('_realName'):
                aliases[values['_aliasName'].lower()] = values['_realName'].lower()
    return match.group(1).lower() if match else '', aliases


def resolve_object(
    value: str | None, source: dict[str, Any], namespaces: dict[str, Any],
    seen: set[tuple[str, str]] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Resolve exact namespaces/aliases, never another namespace's local suffix."""
    if not value:
        return None
    key = value.lstrip('@').lower()
    seen = set() if seen is None else seen
    identity = (source['sourcePath'], key)
    if identity in seen:
        return None
    seen.add(identity)
    local = key
    if '.' in key:
        namespace, local = key.split('.', 1)
        if namespace != source['namespace']:
            alias = source['aliases'].get(key)
            if alias:
                return resolve_object(alias, source, namespaces, seen)
            other = namespaces.get(namespace)
            return resolve_object(key, other, namespaces, seen) if other else None
    obj = source['objects'].get(local)
    if obj:
        return obj, source
    alias = source['aliases'].get(key)
    if alias:
        return resolve_object(alias, source, namespaces, seen)
    return None


def parse_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number


def normalize_effect_name(value: str | None) -> str | None:
    if not isinstance(value, str):
        return None
    name = value.strip().replace('\\', '/').lower()
    name = re.sub(r'\.igz$', '', name)
    return name or None


# ---------------------------------------------------------------------------
# Bolt resolution
# ---------------------------------------------------------------------------

def resolve_bolt_value(
    value: str | None,
    source: dict[str, Any] | None = None,
    namespaces: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Resolve a bolt reference to a bone name plus ordered candidates."""
    raw = value
    if isinstance(value, str) and value.startswith('@') and source is not None:
        resolved = resolve_object(value, source, namespaces or {})
        target = resolved[0] if resolved else None
        if target:
            fields = target['vars']
            for key in ('_bolt', 'mBolt', 'mBoltName', '_bone', 'mBoneName'):
                if fields.get(key):
                    raw = fields[key]
                    break
    if not raw or not isinstance(raw, str):
        return {'raw': None, 'bone': 'Bip01', 'candidates': ['Bip01', 'Bip01 Pelvis'], 'anchor': 'bone', 'resolved': False}

    label = raw.strip()
    upper = label.upper()

    if upper in ORIGIN_BOLTS:
        return {'raw': label, 'bone': None, 'candidates': [], 'anchor': 'origin', 'resolved': True}
    if upper in BOLT_CANDIDATES:
        candidates = BOLT_CANDIDATES[upper]
        return {
            'raw': label,
            'bone': candidates[0] if candidates else None,
            'candidates': candidates,
            'anchor': 'bone' if candidates else 'origin',
            'resolved': bool(candidates),
        }
    if upper.startswith('EBOLT_FX'):
        try:
            index = int(upper.rsplit('FX', 1)[1])
        except ValueError:
            index = 1
        candidates = [f'fx{index:02d}', 'Bip01 Spine2', 'Bip01 Spine']
        return {'raw': label, 'bone': candidates[0], 'candidates': candidates, 'anchor': 'bone', 'resolved': True}
    if upper.startswith('EBOLT_FLOAT'):
        candidates = ['Bip01 Spine2', 'Bip01 Spine']
        return {'raw': label, 'bone': candidates[0], 'candidates': candidates, 'anchor': 'bone', 'resolved': False}
    if upper.startswith('EBOLT_'):
        candidates = ['Bip01 Spine2', 'Bip01 Spine', 'Bip01 Pelvis']
        return {'raw': label, 'bone': candidates[0], 'candidates': candidates, 'anchor': 'bone', 'resolved': False}

    # The game also stores literal bone names in _bolt/mBolt
    # ("Bip01 R Hand", "fx03", "Bip01", "Motion").
    candidates = [label]
    if label.lower() == 'bip01':
        candidates = ['Bip01']
    elif label.lower().startswith('bip01 '):
        candidates.append(label.replace(' HAND', ' HandAttach').replace(' Hand', ' Hand'))
    elif re.fullmatch(r'fx0?\d+', label, re.I):
        index = int(re.sub(r'\D', '', label) or 1)
        candidates = [f'fx{index:02d}', 'Bip01 Spine2', 'Bip01 Spine']
    elif label.lower() == 'motion':
        candidates = ['Motion', 'Bip01']
    return {'raw': label, 'bone': candidates[0], 'candidates': candidates, 'anchor': 'bone', 'resolved': True}


def default_bolt() -> dict[str, Any]:
    return {'raw': None, 'bone': 'Bip01', 'candidates': ['Bip01', 'Bip01 Pelvis'], 'anchor': 'bone', 'resolved': False}


def default_target_bolt() -> dict[str, Any]:
    return {'raw': None, 'bone': None, 'candidates': [], 'anchor': None, 'resolved': False}


# ---------------------------------------------------------------------------
# Catalog helpers
# ---------------------------------------------------------------------------

def is_prop(model: dict[str, Any]) -> bool:
    if model.get('category') == 'props':
        return True
    return bool(PROP_SOURCE_RE.search(model.get('source') or ''))


def norm_name(value: str) -> str:
    return re.sub(r'[^a-z0-9]', '', value.lower())


def strip_ea(value: str) -> str:
    return value[3:] if value.upper().startswith('EA_') else value


def resolve_ps_actor(ps_name: str, characters: set[str]) -> str | None:
    key = ps_name[3:].lower() if ps_name.lower().startswith('ps_') else ps_name.lower()
    if key in characters:
        return key
    if key in PS_ALIASES and PS_ALIASES[key] in characters:
        return PS_ALIASES[key]
    for suffix in SUFFIXES:
        if key.endswith(suffix):
            candidate = key[:-len(suffix)]
            if candidate in characters:
                return candidate
    if key.startswith('ps_'):
        key = key[3:]
    for candidate in sorted(characters, key=len, reverse=True):
        if len(candidate) >= 4 and key.startswith(candidate) and (candidate in characters):
            return candidate
    return None


# ---------------------------------------------------------------------------
# Extraction / loading
# ---------------------------------------------------------------------------

def extract_powerstyles(data_bin: str, mua2bin: str, target: str) -> str:
    if not os.path.isfile(data_bin):
        raise SystemExit(f'data.bin not found: {data_bin}')
    if not os.path.isfile(mua2bin):
        raise SystemExit(f'mua2bin helper not found: {mua2bin}')
    os.makedirs(target, exist_ok=True)
    subprocess.run([mua2bin, data_bin, target], check=True)
    if not os.path.isdir(os.path.join(target, 'powerstyles')):
        raise SystemExit(f'powerstyles directory was not extracted from {data_bin}')
    return target


def load_json(path: str) -> Any:
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# Action extraction
# ---------------------------------------------------------------------------

def powerup_recipient(values: dict[str, str], inherited: str) -> str:
    # Probability and owner/sharee FX filters do not select a combat recipient.
    combat_target = values.get('mApplyCombatTarget', '').lower()
    targets = [values.get(key, '').lower() for key in
               ('mApplyAllies', 'mApplyAlly', 'mApplyHeld')]
    has_target = any(value not in ('', 'false', '0', 'eapply_none') for value in targets)
    has_target |= combat_target not in ('', 'false', '0', 'ects_none', 'ects_self')
    apply_self = values.get('mApplySelf', '').lower()
    owner_only = values.get('mApplyOwnerOnly', '').lower() in ('true', '1')
    has_self = apply_self in ('true', '1') or owner_only or combat_target == 'ects_self'
    if has_target:
        return 'unknown' if has_self else 'target'
    if has_self:
        return 'caster'
    if apply_self in ('false', '0'):
        return 'unknown'
    return inherited


def collect_effect_refs(
    trigger: dict[str, Any], source: dict[str, Any], namespaces: dict[str, Any],
    recipient: str = 'caster',
) -> list[dict[str, Any]]:
    """Walk explicit references only; entity edges must stay in the spawn file."""
    refs: list[dict[str, Any]] = []
    active: set[tuple[str, str]] = set()

    def walk(obj: dict[str, Any], owner: dict[str, Any], who: str,
             entity: bool = False, timing: str = 'trigger',
             bolt_ctx: str | None = None) -> None:
        identity = (owner['sourcePath'], obj['refname'].lower())
        if identity in active:
            return
        active.add(identity)
        values, type_name = obj['vars'], obj['type']
        who = powerup_recipient(values, who)

        def add(field: str, kind: str, target: str = who, when: str = timing,
                bolt: str | None = None, bolt2: str | None = None) -> None:
            effect = normalize_effect_name(values.get(field))
            if effect and not effect.startswith('@'):
                refs.append({
                    'fx': effect, 'kind': kind, 'recipient': target, 'timing': when,
                    'bolt': resolve_bolt_value(bolt, owner, namespaces) if bolt else None,
                    'bolt2': resolve_bolt_value(bolt2, owner, namespaces) if bolt2 else None,
                    'how': values.get('mHowFxIsUsed'), 'object': obj['refname'],
                    'field': field, 'sourcePath': owner['sourcePath'],
                    'sourceSha256': owner['sourceSha256'],
                })

        def follow(value: str | None, target: str = who, as_entity: bool = entity,
                   when: str = timing, bolt: str | None = None) -> None:
            found = resolve_object(value, owner, namespaces)
            if found and (not as_entity or found[1] is owner):
                walk(found[0], found[1], target, as_entity, when, bolt)

        if type_name in ('CCEEffectFile', 'CCEEffectTrail', 'CCEEffectSound'):
            add('mEffectName', 'effect', bolt=values.get('mBolt'), bolt2=values.get('mBolt2'))
        elif type_name in ('CCEAtkBeam', 'CCEAtkBeamFrenzy'):
            for field, kind in (('mBeamEffectName', 'beam'), ('mLoopEffectName', 'beam_loop'),
                                ('mTrailEffectName', 'beam_trail'), ('mSpawnEffectName', 'beam_spawn')):
                add(field, kind, bolt=values.get('mBeamBolt'), bolt2=values.get('mBeamBolt2'))
        elif type_name == 'CCEAtkSpawnProjectile':
            follow(values.get('mSpawnData'), as_entity=True, bolt=values.get('mActorBolt'))
        elif type_name == 'CProjSpawnDataVal':
            add('mSpawnEffectName', 'projectile_spawn', bolt=values.get('mBolt') or bolt_ctx)
            follow(values.get('mEntityDef'), 'projectile', True)
        elif type_name == 'CEntityDef' and entity:
            follow(values.get('mEntity'), 'projectile', True)
        elif entity and type_name.endswith('Entity'):
            for field, kind in (('_loopFx', 'entity_loop'), ('_trailFx', 'entity_trail'),
                                ('_spawnFx', 'entity_spawn')):
                add(field, kind, 'projectile', 'entity_event')
            for field in ('mSpawnBundle', 'mDeathBundle', 'mActBundle', 'mPainBundle'):
                follow(values.get(field), 'projectile', True, 'entity_event')
        elif type_name == 'CEventBundle' and entity:
            add('_effect', 'entity_bundle', 'projectile', 'entity_event')
        elif type_name == 'CFxCoreData':
            for field in ('_fxName', 'mFxName'):
                add(field, 'fx_core', bolt=values.get('_bolt') or values.get('mFxBolt'),
                    bolt2=values.get('_bolt2'))
        elif type_name == 'CCEPowerup' or type_name == 'CPowerup' or type_name.startswith('CPU'):
            add('_effect', 'powerup')
            for value in values.values():
                if value.startswith('@'):
                    found = resolve_object(value, owner, namespaces)
                    if found and (found[0]['type'] in ('CPowerup', 'CFxCoreData')
                                  or found[0]['type'].startswith('CPU')
                                  or found[0]['type'].endswith('List')):
                        follow(value)
        if obj['items']:
            for item in obj['items']:
                follow(item)
        if values.get('mAtkData'):
            found = resolve_object(values['mAtkData'], owner, namespaces)
            if found:
                walk(found[0], found[1], 'target', False, 'hit')
        if timing == 'hit':
            add('mHitEffectName', 'attack_hit', 'target', 'hit')
            add('mHitEnemyEffectName', 'attack_hit_enemy', 'target', 'hit')
        active.remove(identity)

    walk(trigger, source, recipient)
    return refs


def collect_entity_effects(source: dict[str, Any]) -> list[dict[str, Any]]:
    refs = []
    for obj in source['objects'].values():
        fields = ['_loopFx', '_trailFx', '_spawnFx']
        if obj['type'] == 'CEventBundle':
            fields.append('_effect')
        for field in fields:
            effect = normalize_effect_name(obj['vars'].get(field))
            if effect:
                refs.append({
                    'fx': effect, 'entity': obj['refname'], 'entityType': obj['type'],
                    'field': field, 'actor': None, 'clip': None, 'time': None,
                    'recipient': 'projectile' if obj['type'] == 'CProjectileEntity' else 'unknown',
                    'timing': 'entity_event', 'bone': None, 'boneCandidates': [], 'anchor': None,
                    'sourcePath': source['sourcePath'], 'sourceSha256': source['sourceSha256'],
                })
    return refs


def build_actor_clips(
    animation_index: dict[str, str | None],
    animation_dir: str,
    catalog: list[dict[str, Any]],
) -> tuple[dict[str, set[str]], dict[str, set[str]], dict[str, list[str]]]:
    """Map each catalog character to its exported clips and model ids."""
    model_to_characters: dict[str, set[str]] = defaultdict(set)
    character_models: dict[str, set[str]] = defaultdict(set)
    for effect in catalog:
        character = effect.get('character')
        if not character:
            continue
        for model_id in effect.get('modelIds') or []:
            model_to_characters[model_id].add(character)
            character_models[character].add(model_id)

    actor_clips: dict[str, set[str]] = defaultdict(set)
    for model_id, file_name in animation_index.items():
        if not file_name:
            continue
        characters = model_to_characters.get(model_id)
        if not characters:
            continue
        path = os.path.join(animation_dir, file_name)
        try:
            data = load_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        clips = {clip.get('name') for clip in data.get('clips', []) if clip.get('name')}
        for character in characters:
            actor_clips[character].update(clips)

    character_clip_list = {character: sorted(clips) for character, clips in actor_clips.items()}
    return model_to_characters, actor_clips, character_models, character_clip_list


def resolve_clip(enum: str | None, actor: str | None, actor_clips: dict[str, set[str]]) -> str | None:
    if not enum or not actor:
        return None
    clips = actor_clips.get(actor)
    if not clips:
        return None
    by_norm = {norm_name(name): name for name in clips}
    key = enum.upper()
    target = EA_CLIP_ALIASES.get(key)
    if target is None:
        target = strip_ea(enum)
    return by_norm.get(norm_name(target))


def representative_model(character: str, character_models: dict[str, set[str]], models_by_id: dict[str, dict[str, Any]]) -> str | None:
    candidates: Iterable[str] = character_models.get(character, ())
    scored: list[tuple[float, int, str]] = []
    for model_id in candidates:
        model = models_by_id.get(model_id)
        if not model or is_prop(model):
            continue
        score = 0.0
        if model_id == character:
            score += 1000
        if not re.search(r'(?:_alt|_pro|_anti|_boss|_\d+)$', model_id):
            score += 50
        score -= len(model_id) * 0.1
        scored.append((score, len(model_id), model_id))
    if not scored:
        return None
    scored.sort(key=lambda item: (-item[0], item[1], item[2]))
    return scored[0][2]


def build_action_map(
    muc_dir: str,
    catalog: list[dict[str, Any]],
    models: list[dict[str, Any]],
    animation_index: dict[str, str | None],
    animation_dir: str,
) -> dict[str, Any]:
    catalog_by_id: dict[str, dict[str, Any]] = {effect['id'].lower(): effect for effect in catalog}
    characters = {effect['character'] for effect in catalog if effect.get('character')}
    models_by_id = {model['id']: model for model in models}

    model_to_characters, actor_clips, character_models, character_clip_list = build_actor_clips(
        animation_index, animation_dir, catalog
    )

    powerstyles: dict[str, dict[str, Any]] = {}
    effects: dict[str, list[dict[str, Any]]] = defaultdict(list)
    unmapped_enums: dict[str, Counter[str]] = defaultdict(Counter)
    unresolved_effects: Counter[str] = Counter()
    unresolved_bolts: Counter[str] = Counter()
    inferred_actors: dict[str, str] = {}
    default_bolt_entries = 0
    total_entries = 0
    seen: set[tuple[Any, ...]] = set()
    sources: list[dict[str, Any]] = []
    namespaces: dict[str, Any] = {}
    legacy = not os.path.isdir(os.path.join(muc_dir, 'powerstyles'))
    for folder, dirs, files in os.walk(muc_dir):
        dirs.sort()
        for file_name in sorted(files):
            if not file_name.lower().endswith(('.muc', '.mua')):
                continue
            path = os.path.join(folder, file_name)
            with open(path, encoding='latin1') as handle:
                text = handle.read()
            objects = parse_objects(text)
            namespace, aliases = extract_namespace_and_aliases(text, objects)
            rel = os.path.relpath(path, muc_dir).replace(os.sep, '/')
            source = {
                'sourcePath': 'powerstyles/' + rel if legacy else rel,
                'sourceSha256': sha256_file(path), 'namespace': namespace,
                'aliases': aliases, 'objects': objects,
            }
            sources.append(source)
            if namespace:
                if namespace in namespaces:
                    raise ValueError(f'Duplicate igx namespace: {namespace}')
                namespaces[namespace] = source

    entity_effects: dict[str, list[dict[str, Any]]] = defaultdict(list)
    unresolved_entities: Counter[str] = Counter()
    for source in sources:
        parts = source['sourcePath'].split('/')
        group = parts[0]
        if group in ('entities', 'effects_ents'):
            for ref in collect_entity_effects(source):
                catalog_effect = catalog_by_id.get(ref['fx'])
                if catalog_effect:
                    entity_effects[catalog_effect['id']].append({k: v for k, v in ref.items() if k != 'fx'})
                else:
                    unresolved_entities[ref['fx']] += 1
        if group not in ('powerstyles', 'fusion', 'fightstyles') or not source['objects']:
            continue
        ps_name = os.path.splitext(parts[-1])[0]
        victim = 'victim' in ps_name.lower() or 'carryguy' in ps_name.lower()
        actor_key = parts[1] if group == 'fusion' and len(parts) > 2 else ps_name
        actor = None if victim else resolve_ps_actor(actor_key, characters)
        if group == 'fusion' and actor in ('shared', 'sharedfusion'):
            actor = None
        # Preserve legacy powerstyle inference only; victim and fusion ownership
        # cannot be inferred from the character that owns an effect.
        if actor is None and not victim and group == 'powerstyles':
            owners: set[str] = set()
            for node in source['objects'].values():
                if node['type'] != 'CCombatNode':
                    continue
                found = resolve_object(node['vars'].get('_triggers'), source, namespaces)
                if not found:
                    continue
                for trigger_key in found[0]['items']:
                    trigger_found = resolve_object(trigger_key, found[1], namespaces)
                    if trigger_found:
                        for ref in collect_effect_refs(*trigger_found, namespaces):
                            effect = catalog_by_id.get(ref['fx'])
                            if effect and effect.get('character') and ref['recipient'] == 'caster':
                                owners.add(effect['character'])
            if len(owners) == 1:
                actor = next(iter(owners))
                inferred_actors[ps_name] = actor
        node_count = 0
        effect_count = 0

        for node in source['objects'].values():
            if node['type'] != 'CCombatNode':
                continue
            enum = node['vars'].get('_animEnum')
            found = resolve_object(node['vars'].get('_triggers'), source, namespaces)
            if not found:
                continue
            node_count += 1
            node_name = node['vars'].get('_name') or node['refname']
            clip = resolve_clip(enum, actor, actor_clips)
            if actor and enum and enum.upper() != 'EA_NONE' and clip is None:
                unmapped_enums[actor][enum] += 1

            for trigger_key in found[0]['items']:
                trigger_found = resolve_object(trigger_key, found[1], namespaces)
                if not trigger_found:
                    continue
                trigger, trigger_source = trigger_found
                trigger_time = parse_float(trigger['vars'].get('_time'))
                recipient = 'target' if victim else 'caster'
                for ref in collect_effect_refs(trigger, trigger_source, namespaces, recipient):
                    catalog_effect = catalog_by_id.get(ref['fx'])
                    if not catalog_effect:
                        unresolved_effects[ref['fx']] += 1
                        continue
                    effect_id = catalog_effect['id']
                    recipient = 'target' if victim else ref['recipient']
                    bolt = ref['bolt']
                    if bolt:
                        if not bolt['resolved']:
                            unresolved_bolts[str(bolt.get('raw'))] += 1
                    else:
                        bolt = default_bolt() if recipient == 'caster' else default_target_bolt()
                        if recipient == 'caster':
                            default_bolt_entries += 1
                    bolt2 = ref['bolt2']
                    entry_time = trigger_time if ref['timing'] == 'trigger' else None
                    entry = {
                        'ps': ps_name, 'actor': actor, 'node': node_name,
                        'animEnum': enum, 'clip': clip, 'time': entry_time,
                        'sourceTime': trigger_time,
                        'persistent': entry_time is not None and entry_time < 0,
                        'kind': ref['kind'], 'timing': ref['timing'], 'recipient': recipient,
                        'trigger': trigger['refname'], 'effectCharacter': catalog_effect.get('character'),
                        'bolt': bolt['raw'], 'bone': bolt['bone'],
                        'boneCandidates': bolt['candidates'], 'anchor': bolt['anchor'],
                        'boltResolved': bolt['resolved'],
                        'sourcePath': source['sourcePath'], 'sourceSha256': source['sourceSha256'],
                        'effectSourcePath': ref['sourcePath'], 'effectSourceSha256': ref['sourceSha256'],
                        'effectObject': ref['object'], 'effectField': ref['field'],
                    }
                    if bolt2:
                        entry.update(bolt2=bolt2['raw'], bone2=bolt2['bone'], bone2Candidates=bolt2['candidates'])
                    if ref.get('how'):
                        entry['how'] = ref['how']
                    dedupe_key = (effect_id, json.dumps(entry, sort_keys=True))
                    if dedupe_key in seen:
                        continue
                    seen.add(dedupe_key)
                    effects[effect_id].append(entry)
                    effect_count += 1
                    total_entries += 1

        source_key = ps_name if ps_name not in powerstyles else source['sourcePath']
        powerstyles[source_key] = {
            'actor': actor, 'nodes': node_count, 'effects': effect_count,
            'sha256': source['sourceSha256'], 'sourcePath': source['sourcePath'],
            'sourceSha256': source['sourceSha256'],
        }

    # Deterministic ordering inside each effect.
    for effect_id, entries in effects.items():
        entries.sort(key=lambda item: (
            item.get('actor') or '', item.get('clip') or '', item.get('time') if item.get('time') is not None else 1e9,
            item.get('node') or '', item.get('trigger') or '',
        ))

    character_info: dict[str, dict[str, Any]] = {}
    for character in sorted(characters):
        character_info[character] = {
            'modelIds': sorted(character_models.get(character, ())),
            'representativeModel': representative_model(character, character_models, models_by_id),
            'clipCount': len(actor_clips.get(character, ())),
            'unmappedEnums': sorted(unmapped_enums.get(character, {}).keys()),
        }

    actors: dict[str, list[str]] = {}
    for effect_id, entries in effects.items():
        actors[effect_id] = sorted({entry['actor'] for entry in entries if entry.get('actor')})

    return {
        'format': 'mua2_vfx_action_map_v1',
        'provenance': {
            'generator': 'mua2-viewer/tools/vfx_actions.py',
            'powerstyleSource': 'data.bin: powerstyles/, fusion/, fightstyles/ (recursive Alchemy IGZ XML)',
            'powerstyleCount': len(powerstyles),
            'sources': [{
                'sourcePath': source['sourcePath'], 'sourceSha256': source['sourceSha256'],
            } for source in sources],
            'catalog': f'assets/vfx/{CATALOG_FILENAME}',
            'animations': 'assets/animations/index.json + exported HKX clips',
            'note': 'Explicit references only; missing actors, clips and event times stay null.',
            'limitations': [
                'Cross-file entity spawn/bundle edges are not followed.',
                'Standalone entityEffects are not combat action bindings.',
                'Hit and entity-event times require runtime events; sourceTime is the initiating trigger time.',
            ],
        },
        'aliases': {
            'powerstyles': PS_ALIASES,
            'clips': EA_CLIP_ALIASES,
        },
        'powerstyles': powerstyles,
        'characters': character_info,
        'effects': dict(sorted(effects.items())),
        'entityEffects': dict(sorted(entity_effects.items())),
        'actors': dict(sorted(actors.items())),
        'stats': {
            'effectsWithActions': len(effects),
            'totalActionEntries': total_entries,
            'standaloneEntityEffects': len(entity_effects),
            'unresolvedEffectRefs': sum(unresolved_effects.values()),
            'uniqueUnresolvedEffectRefs': len(unresolved_effects),
            'unresolvedEffectNames': dict(sorted(unresolved_effects.items())),
            'unresolvedBolts': sum(unresolved_bolts.values()),
            'unresolvedBoltNames': dict(sorted(unresolved_bolts.items())),
            'defaultBoltEntries': default_bolt_entries,
            'inferredActors': dict(sorted(inferred_actors.items())),
            'unmappedEnumCount': sum(len(value) for value in unmapped_enums.values()),
            'unmappedEnums': {character: sorted(value.keys()) for character, value in sorted(unmapped_enums.items())},
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--muc-dir', help='directory containing powerstyles/*.muc (legacy) or full data extraction')
    parser.add_argument('--data-bin', default=DEFAULT_DATA_BIN)
    parser.add_argument('--mua2bin', default=DEFAULT_MUA2BIN)
    parser.add_argument('--catalog', default=DEFAULT_CATALOG)
    parser.add_argument('--models', default=DEFAULT_MODELS)
    parser.add_argument('--anim-index', default=DEFAULT_ANIM_INDEX)
    parser.add_argument('--anim-dir', default=DEFAULT_ANIM_DIR)
    parser.add_argument('--out', default=DEFAULT_OUT)
    parser.add_argument('--keep-extracted', action='store_true')
    args = parser.parse_args()

    temporary: tempfile.TemporaryDirectory[str] | None = None
    muc_dir = args.muc_dir
    if not muc_dir:
        temporary = tempfile.TemporaryDirectory(prefix='mua2-data-')
        muc_dir = extract_powerstyles(args.data_bin, args.mua2bin, temporary.name)
    if not os.path.isdir(muc_dir):
        raise SystemExit(f'data directory not found: {muc_dir}')

    catalog = load_effects_catalog(args.catalog)['effects']
    models = load_json(args.models)['models']
    animation_index = load_json(args.anim_index)

    action_map = build_action_map(muc_dir, catalog, models, animation_index, args.anim_dir)
    action_map['provenance']['dataBin'] = os.path.relpath(args.data_bin, ROOT)
    if os.path.isfile(args.data_bin):
        action_map['provenance']['dataBinSha256'] = sha256_file(args.data_bin)
    action_map['provenance']['catalogSha256'] = sha256_file(args.catalog)
    action_map['provenance']['modelsSha256'] = sha256_file(args.models)
    action_map['provenance']['animIndexSha256'] = sha256_file(args.anim_index)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    temp_out = args.out + '.tmp'
    with open(temp_out, 'w', encoding='utf-8', newline='\n') as handle:
        json.dump(action_map, handle, ensure_ascii=False, indent=1, sort_keys=False)
        handle.write('\n')
    os.replace(temp_out, args.out)

    stats = action_map['stats']
    print(f"action map: {args.out}")
    print(f"  effects with actions: {stats['effectsWithActions']}")
    print(f"  action entries:       {stats['totalActionEntries']}")
    print(f"  entity effects:       {stats['standaloneEntityEffects']}")
    print(f"  characters:           {len(action_map['characters'])}")
    print(f"  unresolved effects:   {stats['uniqueUnresolvedEffectRefs']} unique / {stats['unresolvedEffectRefs']} refs")
    print(f"  unresolved bolts:     {stats['unresolvedBolts']}")
    print(f"  unmapped enums:       {stats['unmappedEnumCount']} (actor/enum pairs)")

    if temporary is not None:
        if args.keep_extracted:
            print(f"  extracted data kept at: {muc_dir}")
        else:
            temporary.cleanup()
    return 0


if __name__ == '__main__':
    sys.exit(main())
