import * as THREE from 'three';

/**
 * Procedural animation clips for MUA2 characters based on standard Bip01 hierarchy.
 * Generates THREE.AnimationClip instances targeting Bip01_* bone names.
 */

// Bone rest orientation helpers
function qRot(axis, rad) {
  return new THREE.Quaternion().setFromAxisAngle(axis, rad);
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

/**
 * Build a QuaternionKeyframeTrack from an array of (time, quat) keyframes.
 * Times in seconds, relative to bone rest pose (multiplies rest pose if restQuats provided).
 */
function makeQuatTrack(boneName, times, quats) {
  const values = [];
  for (const q of quats) {
    values.push(q.x, q.y, q.z, q.w);
  }
  return new THREE.QuaternionKeyframeTrack(`${boneName}.quaternion`, times, values);
}

function makePosTrack(boneName, times, positions) {
  const values = [];
  for (const p of positions) {
    values.push(p.x, p.y, p.z);
  }
  return new THREE.VectorKeyframeTrack(`${boneName}.position`, times, values);
}

/**
 * Find resting quaternions and positions from a model's bones to make delta clips.
 */
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
 * Procedural Idle animation (breathing, pelvic sway, gentle arm sway).
 */
export function createIdleClip(model, duration = 3.0) {
  const rest = getBoneRest(model);
  const tracks = [];
  const N = 31;
  const times = [];
  for (let i = 0; i < N; i++) times.push((i / (N - 1)) * duration);

  function applyRot(boneName, fn) {
    const r = rest[boneName];
    if (!r) return;
    const quats = times.map((t) => {
      const qDelta = fn(t);
      return r.quaternion.clone().multiply(qDelta);
    });
    tracks.push(makeQuatTrack(boneName, times, quats));
  }

  // Spine & Spine1 breathing
  applyRot('Bip01_Spine', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    return qRot(X, Math.sin(phase) * 0.04);
  });
  applyRot('Bip01_Spine1', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    return qRot(X, Math.sin(phase) * 0.035);
  });
  applyRot('Bip01_Spine2', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    return qRot(X, Math.sin(phase) * 0.02);
  });

  // Clavicles lifting with breath
  applyRot('Bip01_L_Clavicle', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    return qRot(Z, Math.sin(phase) * 0.03);
  });
  applyRot('Bip01_R_Clavicle', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    return qRot(Z, -Math.sin(phase) * 0.03);
  });

  // Head subtle glance / stabilization
  applyRot('Bip01_Head', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    const pitch = -Math.sin(phase) * 0.04;
    const yaw = Math.sin(phase * 0.5) * 0.03;
    return qRot(X, pitch).multiply(qRot(Y, yaw));
  });

  // Pelvis subtle bounce
  if (rest['Bip01_Pelvis']) {
    const pRest = rest['Bip01_Pelvis'].position;
    const positions = times.map((t) => {
      const phase = (t / duration) * Math.PI * 2;
      return new THREE.Vector3(
        pRest.x,
        pRest.y - Math.sin(phase) * 0.3,
        pRest.z
      );
    });
    tracks.push(makePosTrack('Bip01_Pelvis', times, positions));
  }

  // Arms relaxed sway
  applyRot('Bip01_L_UpperArm', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    return qRot(X, Math.sin(phase) * 0.025).multiply(qRot(Z, -0.05));
  });
  applyRot('Bip01_R_UpperArm', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    return qRot(X, Math.sin(phase) * 0.025).multiply(qRot(Z, 0.05));
  });

  return new THREE.AnimationClip('idle', duration, tracks);
}

/**
 * Procedural Combat Stance (fighting crouch, fists up, ready breathing).
 */
export function createCombatClip(model, duration = 2.0) {
  const rest = getBoneRest(model);
  const tracks = [];
  const N = 25;
  const times = [];
  for (let i = 0; i < N; i++) times.push((i / (N - 1)) * duration);

  function applyRot(boneName, fn) {
    const r = rest[boneName];
    if (!r) return;
    const quats = times.map((t) => r.quaternion.clone().multiply(fn(t)));
    tracks.push(makeQuatTrack(boneName, times, quats));
  }

  // Pelvis crouch & turn slightly to the side
  applyRot('Bip01_Pelvis', (t) => {
    const pulse = Math.sin((t / duration) * Math.PI * 2) * 0.02;
    return qRot(Y, 0.25).multiply(qRot(X, 0.15 + pulse));
  });

  if (rest['Bip01_Pelvis']) {
    const pRest = rest['Bip01_Pelvis'].position;
    const positions = times.map((t) => {
      const pulse = Math.sin((t / duration) * Math.PI * 2) * 0.2;
      return new THREE.Vector3(pRest.x, pRest.y - 2.5 + pulse, pRest.z);
    });
    tracks.push(makePosTrack('Bip01_Pelvis', times, positions));
  }

  // Legs bent in stance
  applyRot('Bip01_L_Thigh', () => qRot(X, -0.35).multiply(qRot(Y, -0.15)));
  applyRot('Bip01_L_Calf', () => qRot(X, 0.55));
  applyRot('Bip01_L_Foot', () => qRot(X, -0.2));

  applyRot('Bip01_R_Thigh', () => qRot(X, -0.25).multiply(qRot(Y, 0.2)));
  applyRot('Bip01_R_Calf', () => qRot(X, 0.45));
  applyRot('Bip01_R_Foot', () => qRot(X, -0.2));

  // Spine leaning forward, counter-rotated
  applyRot('Bip01_Spine', (t) => {
    const breath = Math.sin((t / duration) * Math.PI * 2) * 0.03;
    return qRot(X, 0.15 + breath).multiply(qRot(Y, -0.15));
  });
  applyRot('Bip01_Spine1', () => qRot(X, 0.1));
  applyRot('Bip01_Head', (t) => {
    const alert = Math.sin((t / duration) * Math.PI * 2) * 0.02;
    return qRot(Y, -0.1).multiply(qRot(X, -0.15 + alert));
  });

  // Guard: Left arm forward, right arm protecting chin
  applyRot('Bip01_L_Clavicle', () => qRot(Z, 0.15).multiply(qRot(X, 0.1)));
  applyRot('Bip01_L_UpperArm', (t) => {
    const weave = Math.sin((t / duration) * Math.PI * 2) * 0.03;
    return qRot(X, 0.9 + weave).multiply(qRot(Y, 0.5)).multiply(qRot(Z, 0.3));
  });
  applyRot('Bip01_L_Forearm', () => qRot(X, 1.4));
  applyRot('Bip01_L_Hand', () => qRot(X, 0.2));

  applyRot('Bip01_R_Clavicle', () => qRot(Z, -0.1).multiply(qRot(X, 0.1)));
  applyRot('Bip01_R_UpperArm', (t) => {
    const weave = -Math.sin((t / duration) * Math.PI * 2) * 0.03;
    return qRot(X, 0.8 + weave).multiply(qRot(Y, -0.4)).multiply(qRot(Z, -0.3));
  });
  applyRot('Bip01_R_Forearm', () => qRot(X, 1.55));
  applyRot('Bip01_R_Hand', () => qRot(X, 0.2));

  return new THREE.AnimationClip('combat', duration, tracks);
}

/**
 * Procedural Walk Cycle (forward stride, arm swing, pelvis bob).
 */
export function createWalkClip(model, duration = 1.2) {
  const rest = getBoneRest(model);
  const tracks = [];
  const N = 25;
  const times = [];
  for (let i = 0; i < N; i++) times.push((i / (N - 1)) * duration);

  function applyRot(boneName, fn) {
    const r = rest[boneName];
    if (!r) return;
    const quats = times.map((t) => r.quaternion.clone().multiply(fn(t)));
    tracks.push(makeQuatTrack(boneName, times, quats));
  }

  // Pelvis roll, sway, and double bounce per stride
  applyRot('Bip01_Pelvis', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    const yaw = Math.sin(phase) * 0.08;
    const roll = Math.cos(phase) * 0.04;
    return qRot(Y, yaw).multiply(qRot(Z, roll));
  });

  if (rest['Bip01_Pelvis']) {
    const pRest = rest['Bip01_Pelvis'].position;
    const positions = times.map((t) => {
      const phase = (t / duration) * Math.PI * 2;
      const bob = Math.sin(phase * 2) * 0.6;
      return new THREE.Vector3(pRest.x, pRest.y + bob, pRest.z);
    });
    tracks.push(makePosTrack('Bip01_Pelvis', times, positions));
  }

  // Left & Right Thighs (counter-phase swing)
  applyRot('Bip01_L_Thigh', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    return qRot(X, Math.sin(phase) * 0.55);
  });
  applyRot('Bip01_L_Calf', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    // bends when leg is swinging forward (negative sin)
    const bend = Math.max(0, -Math.sin(phase)) * 0.85;
    return qRot(X, bend);
  });
  applyRot('Bip01_L_Foot', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    return qRot(X, Math.sin(phase) * 0.2);
  });

  applyRot('Bip01_R_Thigh', (t) => {
    const phase = (t / duration) * Math.PI * 2 + Math.PI;
    return qRot(X, Math.sin(phase) * 0.55);
  });
  applyRot('Bip01_R_Calf', (t) => {
    const phase = (t / duration) * Math.PI * 2 + Math.PI;
    const bend = Math.max(0, -Math.sin(phase)) * 0.85;
    return qRot(X, bend);
  });
  applyRot('Bip01_R_Foot', (t) => {
    const phase = (t / duration) * Math.PI * 2 + Math.PI;
    return qRot(X, Math.sin(phase) * 0.2);
  });

  // Spine counter-rotates with pelvis
  applyRot('Bip01_Spine', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    return qRot(Y, -Math.sin(phase) * 0.08).multiply(qRot(X, 0.08));
  });

  // Arms swing in opposition to legs
  applyRot('Bip01_L_UpperArm', (t) => {
    const phase = (t / duration) * Math.PI * 2 + Math.PI;
    return qRot(X, Math.sin(phase) * 0.45).multiply(qRot(Z, -0.1));
  });
  applyRot('Bip01_L_Forearm', (t) => {
    const phase = (t / duration) * Math.PI * 2 + Math.PI;
    return qRot(X, 0.35 + Math.max(0, Math.sin(phase)) * 0.3);
  });

  applyRot('Bip01_R_UpperArm', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    return qRot(X, Math.sin(phase) * 0.45).multiply(qRot(Z, 0.1));
  });
  applyRot('Bip01_R_Forearm', (t) => {
    const phase = (t / duration) * Math.PI * 2;
    return qRot(X, 0.35 + Math.max(0, Math.sin(phase)) * 0.3);
  });

  return new THREE.AnimationClip('walk', duration, tracks);
}

/**
 * Procedural Attack (Punch Combo: Jab -> Cross).
 */
export function createAttackClip(model, duration = 1.5) {
  const rest = getBoneRest(model);
  const tracks = [];
  const N = 31;
  const times = [];
  for (let i = 0; i < N; i++) times.push((i / (N - 1)) * duration);

  function applyRot(boneName, fn) {
    const r = rest[boneName];
    if (!r) return;
    const quats = times.map((t) => r.quaternion.clone().multiply(fn(t)));
    tracks.push(makeQuatTrack(boneName, times, quats));
  }

  // Segment 1: Jab (0 to 0.6s), Segment 2: Cross (0.7 to 1.3s), Recover (1.3 to 1.5s)
  applyRot('Bip01_Spine', (t) => {
    let yaw = 0;
    if (t < 0.6) {
      const p = t / 0.6;
      yaw = Math.sin(p * Math.PI) * 0.35; // rotate torso to extend left jab
    } else if (t < 1.3) {
      const p = (t - 0.7) / 0.6;
      yaw = -Math.sin(p * Math.PI) * 0.55; // rotate torso to thrust right cross
    }
    return qRot(Y, yaw).multiply(qRot(X, 0.1));
  });

  // Left Arm (Jab)
  applyRot('Bip01_L_UpperArm', (t) => {
    if (t < 0.6) {
      const p = t / 0.6;
      const reach = Math.sin(p * Math.PI);
      return qRot(X, 1.4 * reach).multiply(qRot(Y, 0.3 * reach));
    }
    // guard
    return qRot(X, 0.6).multiply(qRot(Z, -0.2));
  });
  applyRot('Bip01_L_Forearm', (t) => {
    if (t < 0.6) {
      const p = t / 0.6;
      const reach = Math.sin(p * Math.PI);
      return qRot(X, 0.1 * reach + 1.2 * (1 - reach)); // unbends on punch
    }
    return qRot(X, 1.2);
  });

  // Right Arm (Cross)
  applyRot('Bip01_R_UpperArm', (t) => {
    if (t >= 0.6 && t < 1.3) {
      const p = (t - 0.7) / 0.6;
      const reach = Math.sin(Math.max(0, p) * Math.PI);
      return qRot(X, 1.5 * reach).multiply(qRot(Y, -0.4 * reach));
    }
    return qRot(X, 0.6).multiply(qRot(Z, 0.2));
  });
  applyRot('Bip01_R_Forearm', (t) => {
    if (t >= 0.6 && t < 1.3) {
      const p = (t - 0.7) / 0.6;
      const reach = Math.sin(Math.max(0, p) * Math.PI);
      return qRot(X, 0.1 * reach + 1.3 * (1 - reach));
    }
    return qRot(X, 1.3);
  });

  // Legs stance
  applyRot('Bip01_L_Thigh', () => qRot(X, -0.25));
  applyRot('Bip01_L_Calf', () => qRot(X, 0.4));
  applyRot('Bip01_R_Thigh', () => qRot(X, -0.2));
  applyRot('Bip01_R_Calf', () => qRot(X, 0.35));

  return new THREE.AnimationClip('attack', duration, tracks);
}

/**
 * Procedural Heroic Pose (chest out, fists on hips / triumphant stance).
 */
export function createHeroicClip(model, duration = 3.0) {
  const rest = getBoneRest(model);
  const tracks = [];
  const N = 21;
  const times = [];
  for (let i = 0; i < N; i++) times.push((i / (N - 1)) * duration);

  function applyRot(boneName, fn) {
    const r = rest[boneName];
    if (!r) return;
    const quats = times.map((t) => r.quaternion.clone().multiply(fn(t)));
    tracks.push(makeQuatTrack(boneName, times, quats));
  }

  // Chest out, tall posture
  applyRot('Bip01_Spine', (t) => {
    const breath = Math.sin((t / duration) * Math.PI * 2) * 0.02;
    return qRot(X, -0.15 + breath);
  });
  applyRot('Bip01_Spine1', () => qRot(X, -0.1));
  applyRot('Bip01_Head', (t) => {
    const sway = Math.sin((t / duration) * Math.PI * 2) * 0.02;
    return qRot(X, -0.25).multiply(qRot(Y, sway)); // head tilted upward proud
  });

  // Arms on hips (superhero stance)
  applyRot('Bip01_L_Clavicle', () => qRot(Z, 0.2));
  applyRot('Bip01_L_UpperArm', () => qRot(X, 0.3).multiply(qRot(Z, -0.75)).multiply(qRot(Y, -0.3)));
  applyRot('Bip01_L_Forearm', () => qRot(X, 1.85));
  applyRot('Bip01_L_Hand', () => qRot(Z, -0.4));

  applyRot('Bip01_R_Clavicle', () => qRot(Z, -0.2));
  applyRot('Bip01_R_UpperArm', () => qRot(X, 0.3).multiply(qRot(Z, 0.75)).multiply(qRot(Y, 0.3)));
  applyRot('Bip01_R_Forearm', () => qRot(X, 1.85));
  applyRot('Bip01_R_Hand', () => qRot(Z, 0.4));

  // Strong wide stance
  applyRot('Bip01_L_Thigh', () => qRot(Z, -0.12).multiply(qRot(X, -0.05)));
  applyRot('Bip01_R_Thigh', () => qRot(Z, 0.12).multiply(qRot(X, -0.05)));

  return new THREE.AnimationClip('heroic', duration, tracks);
}
