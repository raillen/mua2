import * as THREE from 'three';

/**
 * Procedural animation clips for MUA2 characters based on Bip01 hierarchy.
 *
 * MUA2 Bone Local Space (3ds Max Biped):
 *   - Z axis: Primary flexion/extension (Pitch)
 *       Spine:    +Z lean forward,   -Z lean back
 *       Head:     +Z nod down,       -Z look up
 *       Thigh:    +Z leg forward,    -Z leg back
 *       Calf:     -Z bend knee,       0 straight
 *       UpperArm: +Z swing forward,  -Z swing back
 *       Forearm:  +Z bend elbow,      0 straight
 *   - Y axis: Abduction/Yaw (lateral swing / torso twist)
 *   - X axis: Axial twist along bone length
 */

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

function qRot(axis, rad) {
  return new THREE.Quaternion().setFromAxisAngle(axis, rad);
}

function makeQuatTrack(boneName, times, quats) {
  const values = [];
  for (const q of quats) values.push(q.x, q.y, q.z, q.w);
  return new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values);
}

function makePosTrack(boneName, times, positions) {
  const values = [];
  for (const p of positions) values.push(p.x, p.y, p.z);
  return new THREE.VectorKeyframeTrack(`${boneName}.position`, times, values);
}

function getBoneRest(model) {
  const rest = {};
  model.traverse((o) => {
    if (o.isBone) {
      rest[o.name] = {
        quaternion: o.quaternion.clone(),
        position: o.position.clone()
      };
    }
  });
  return rest;
}

/**
 * 1. Idle (natural breathing, slight weight shift).
 */
export function createIdleClip(model, duration = 3.0) {
  const rest = getBoneRest(model);
  const tracks = [];
  const N = 25;
  const times = [];
  for (let i = 0; i < N; i++) times.push((i / (N - 1)) * duration);

  function apply(name, fn) {
    const r = rest[name];
    if (!r) return;
    const quats = times.map((t) => r.quaternion.clone().multiply(fn(t)));
    tracks.push(makeQuatTrack(name, times, quats));
  }

  // Spine breathing: gentle pitch on Z
  apply('Bip01_Spine', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Z, Math.sin(p) * 0.035).multiply(qRot(Y, Math.cos(p * 0.5) * 0.015));
  });
  apply('Bip01_Spine1', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Z, Math.sin(p) * 0.025);
  });
  apply('Bip01_Spine2', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Z, Math.sin(p) * 0.015);
  });

  // Clavicles gently rising
  apply('Bip01_L_Clavicle', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Z, Math.sin(p) * 0.025);
  });
  apply('Bip01_R_Clavicle', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Z, -Math.sin(p) * 0.025);
  });

  // Head subtle counter-tilt
  apply('Bip01_Head', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Z, -Math.sin(p) * 0.02).multiply(qRot(Y, Math.sin(p * 0.5) * 0.025));
  });

  // Arms relaxed at sides
  apply('Bip01_L_UpperArm', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Z, Math.sin(p) * 0.02);
  });
  apply('Bip01_R_UpperArm', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Z, -Math.sin(p) * 0.02);
  });

  return new THREE.AnimationClip('idle', duration, tracks);
}

/**
 * 2. Walk Cycle (anatomically correct knee/hip flexion and arm counter-swing).
 */
export function createWalkClip(model, duration = 1.1) {
  const rest = getBoneRest(model);
  const tracks = [];
  const N = 25;
  const times = [];
  for (let i = 0; i < N; i++) times.push((i / (N - 1)) * duration);

  function apply(name, fn) {
    const r = rest[name];
    if (!r) return;
    const quats = times.map((t) => r.quaternion.clone().multiply(fn(t)));
    tracks.push(makeQuatTrack(name, times, quats));
  }

  // Pelvis subtle yaw twist + roll
  apply('Bip01_Pelvis', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Y, Math.sin(p) * 0.07).multiply(qRot(X, Math.cos(p) * 0.03));
  });

  // Left Leg: Thigh swings forward (+Z) & backward (-Z); Calf bends backward (-Z)
  apply('Bip01_L_Thigh', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Z, Math.sin(p) * 0.42);
  });
  apply('Bip01_L_Calf', (t) => {
    const p = (t / duration) * Math.PI * 2;
    // Bends back during the recovery/swing phase (when thigh moves forward)
    const bend = -Math.max(0, Math.sin(p)) * 0.65;
    return qRot(Z, bend);
  });

  // Right Leg (180 deg out of phase)
  apply('Bip01_R_Thigh', (t) => {
    const p = (t / duration) * Math.PI * 2 + Math.PI;
    return qRot(Z, Math.sin(p) * 0.42);
  });
  apply('Bip01_R_Calf', (t) => {
    const p = (t / duration) * Math.PI * 2 + Math.PI;
    const bend = -Math.max(0, Math.sin(p)) * 0.65;
    return qRot(Z, bend);
  });

  // Spine counter-rotates with pelvis
  apply('Bip01_Spine', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Y, -Math.sin(p) * 0.06).multiply(qRot(Z, 0.05));
  });

  // Arms swing in opposition to legs (Left arm with Right leg)
  apply('Bip01_L_UpperArm', (t) => {
    const p = (t / duration) * Math.PI * 2 + Math.PI;
    return qRot(Z, Math.sin(p) * 0.35);
  });
  apply('Bip01_L_Forearm', (t) => {
    const p = (t / duration) * Math.PI * 2 + Math.PI;
    const bend = Math.max(0, Math.sin(p)) * 0.35 + 0.15;
    return qRot(Z, bend);
  });

  apply('Bip01_R_UpperArm', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Z, -Math.sin(p) * 0.35);
  });
  apply('Bip01_R_Forearm', (t) => {
    const p = (t / duration) * Math.PI * 2;
    const bend = Math.max(0, -Math.sin(p)) * 0.35 + 0.15;
    return qRot(Z, bend);
  });

  return new THREE.AnimationClip('walk', duration, tracks);
}

/**
 * 3. Combat Stance (crouched, elbows bent, hands ready).
 */
export function createCombatClip(model, duration = 2.0) {
  const rest = getBoneRest(model);
  const tracks = [];
  const N = 25;
  const times = [];
  for (let i = 0; i < N; i++) times.push((i / (N - 1)) * duration);

  function apply(name, fn) {
    const r = rest[name];
    if (!r) return;
    const quats = times.map((t) => r.quaternion.clone().multiply(fn(t)));
    tracks.push(makeQuatTrack(name, times, quats));
  }

  // Spine leans forward
  apply('Bip01_Spine', (t) => {
    const pulse = Math.sin((t / duration) * Math.PI * 2) * 0.02;
    return qRot(Z, 0.12 + pulse).multiply(qRot(Y, -0.15));
  });
  apply('Bip01_Spine1', () => qRot(Z, 0.08));
  apply('Bip01_Head', (t) => {
    const pulse = Math.sin((t / duration) * Math.PI * 2) * 0.015;
    return qRot(Z, -0.12 + pulse).multiply(qRot(Y, 0.15));
  });

  // Knees bent in stance (-Z is knee flexion)
  apply('Bip01_L_Thigh', () => qRot(Z, 0.25).multiply(qRot(Y, 0.1)));
  apply('Bip01_L_Calf', () => qRot(Z, -0.45));
  apply('Bip01_R_Thigh', () => qRot(Z, -0.15).multiply(qRot(Y, -0.1)));
  apply('Bip01_R_Calf', () => qRot(Z, -0.35));

  // Arms up in guard (+Z is forward / elbow flexion)
  apply('Bip01_L_UpperArm', (t) => {
    const weave = Math.sin((t / duration) * Math.PI * 2) * 0.02;
    return qRot(Z, 0.55 + weave).multiply(qRot(Y, 0.25));
  });
  apply('Bip01_L_Forearm', () => qRot(Z, 0.85));

  apply('Bip01_R_UpperArm', (t) => {
    const weave = -Math.sin((t / duration) * Math.PI * 2) * 0.02;
    return qRot(Z, 0.45 + weave).multiply(qRot(Y, -0.2));
  });
  apply('Bip01_R_Forearm', () => qRot(Z, 0.95));

  return new THREE.AnimationClip('combat', duration, tracks);
}

/**
 * 4. Attack (Jab -> Cross combo).
 */
export function createAttackClip(model, duration = 1.4) {
  const rest = getBoneRest(model);
  const tracks = [];
  const N = 29;
  const times = [];
  for (let i = 0; i < N; i++) times.push((i / (N - 1)) * duration);

  function apply(name, fn) {
    const r = rest[name];
    if (!r) return;
    const quats = times.map((t) => r.quaternion.clone().multiply(fn(t)));
    tracks.push(makeQuatTrack(name, times, quats));
  }

  // Torso twist driving punches
  apply('Bip01_Spine', (t) => {
    let yaw = 0;
    if (t < 0.6) {
      // Left Jab: twist torso right (+Y)
      const p = t / 0.6;
      yaw = Math.sin(p * Math.PI) * 0.25;
    } else if (t < 1.2) {
      // Right Cross: twist torso left (-Y)
      const p = (t - 0.6) / 0.6;
      yaw = -Math.sin(p * Math.PI) * 0.45;
    }
    return qRot(Y, yaw).multiply(qRot(Z, 0.1));
  });

  // Left Arm (Jab at t 0..0.6)
  apply('Bip01_L_UpperArm', (t) => {
    if (t < 0.6) {
      const p = t / 0.6;
      const thrust = Math.sin(p * Math.PI);
      return qRot(Z, 0.35 + thrust * 0.85);
    }
    return qRot(Z, 0.45);
  });
  apply('Bip01_L_Forearm', (t) => {
    if (t < 0.6) {
      const p = t / 0.6;
      const thrust = Math.sin(p * Math.PI);
      // unbends to strike, then returns
      return qRot(Z, 0.85 * (1 - thrust) + 0.15);
    }
    return qRot(Z, 0.85);
  });

  // Right Arm (Cross at t 0.6..1.2)
  apply('Bip01_R_UpperArm', (t) => {
    if (t >= 0.6 && t < 1.2) {
      const p = (t - 0.6) / 0.6;
      const thrust = Math.sin(p * Math.PI);
      return qRot(Z, 0.3 + thrust * 0.95);
    }
    return qRot(Z, 0.35);
  });
  apply('Bip01_R_Forearm', (t) => {
    if (t >= 0.6 && t < 1.2) {
      const p = (t - 0.6) / 0.6;
      const thrust = Math.sin(p * Math.PI);
      return qRot(Z, 0.95 * (1 - thrust) + 0.15);
    }
    return qRot(Z, 0.95);
  });

  // Stance stability
  apply('Bip01_L_Thigh', () => qRot(Z, 0.15));
  apply('Bip01_L_Calf', () => qRot(Z, -0.3));
  apply('Bip01_R_Thigh', () => qRot(Z, -0.1));
  apply('Bip01_R_Calf', () => qRot(Z, -0.25));

  return new THREE.AnimationClip('attack', duration, tracks);
}

/**
 * 5. Heroic Pose (tall posture, arms on hips).
 */
export function createHeroicClip(model, duration = 3.0) {
  const rest = getBoneRest(model);
  const tracks = [];
  const N = 25;
  const times = [];
  for (let i = 0; i < N; i++) times.push((i / (N - 1)) * duration);

  function apply(name, fn) {
    const r = rest[name];
    if (!r) return;
    const quats = times.map((t) => r.quaternion.clone().multiply(fn(t)));
    tracks.push(makeQuatTrack(name, times, quats));
  }

  // Chest puffed out (-Z is lean back)
  apply('Bip01_Spine', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Z, -0.1 + Math.sin(p) * 0.02);
  });
  apply('Bip01_Spine1', () => qRot(Z, -0.05));
  apply('Bip01_Head', (t) => {
    const p = (t / duration) * Math.PI * 2;
    return qRot(Z, -0.12 + Math.sin(p) * 0.015).multiply(qRot(Y, 0.1)); // proud head tilt
  });

  // Arms akimbo (hands near hips)
  apply('Bip01_L_UpperArm', () => qRot(Y, 0.35).multiply(qRot(Z, 0.25)));
  apply('Bip01_L_Forearm', () => qRot(Z, 1.15));

  apply('Bip01_R_UpperArm', () => qRot(Y, -0.35).multiply(qRot(Z, 0.25)));
  apply('Bip01_R_Forearm', () => qRot(Z, 1.15));

  // Solid grounded stance
  apply('Bip01_L_Thigh', () => qRot(Y, 0.1));
  apply('Bip01_R_Thigh', () => qRot(Y, -0.1));

  return new THREE.AnimationClip('heroic', duration, tracks);
}
