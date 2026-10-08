import {
  creativeFlightMovement, firstPersonMode, requireBasis, requireFinite,
  requireFlightState, requireSurvivalState, survivalWalkMovement,
} from "./navigation-contract.mjs";
import {flightIntent, walkIntent} from "./navigation-keyboard.mjs";

// Survivalcraft's player HumanModel advances its footstep phase by 0.48 per metre.
const playerFootstepStride = 1 / 0.48;

export function createNavigationMovement({
  mode, movementMode, initialFlightState, initialWalkState, stepFlight, stepWalk,
  readHorizontalBasis, applyFlightState, applyWalkState, bounds, collisionAt,
  walkSound = () => null,
}) {
  let flightState = initialFlightState;
  let survivalState = initialWalkState;
  let groundedDistance = 0;

  return {
    get grounded() { return movementMode === survivalWalkMovement && survivalState.grounded; },
    get crouching() { return movementMode === survivalWalkMovement && survivalState.crouching; },
    clearMotion() {
      if (mode !== firstPersonMode) return;
      groundedDistance = 0;
      if (movementMode === creativeFlightMovement) {
        flightState = {
          x: flightState.x, y: flightState.y, z: flightState.z,
          velocityX: 0, velocityY: 0, velocityZ: 0,
        };
        applyFlightState(flightState);
      } else {
        survivalState = {...survivalState, velocityX: 0, velocityZ: 0};
        applyWalkState(survivalState);
      }
    },
    update(keys, deltaMilliseconds) {
      if (mode !== firstPersonMode) return;
      const basis = requireBasis(readHorizontalBasis());
      const delta = requireFinite(deltaMilliseconds, "Voxel navigation frame delta");
      if (movementMode === creativeFlightMovement) {
        flightState = requireFlightState(stepFlight(flightState, flightIntent(keys), basis, delta, bounds));
        applyFlightState(flightState);
      } else {
        const previous = survivalState;
        survivalState = requireSurvivalState(stepWalk(
          survivalState, walkIntent(keys), basis, delta, bounds, collisionAt,
        ));
        applyWalkState(survivalState);
        if (!survivalState.grounded) {
          groundedDistance = 0;
        } else if (!previous.grounded && previous.velocityY < -1) {
          groundedDistance = 0;
          walkSound(survivalState, survivalState.crouching, true);
        } else {
          const distance = Math.hypot(survivalState.x - previous.x, survivalState.z - previous.z);
          groundedDistance += Math.min(distance, 0.35);
          if (groundedDistance >= playerFootstepStride) {
            groundedDistance %= playerFootstepStride;
            walkSound(survivalState, survivalState.crouching, false);
          }
        }
      }
    },
  };
}
