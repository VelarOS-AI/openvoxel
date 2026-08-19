import fc from "fast-check";

const coordinate = fc.integer({ min: -33554431, max: 33554431 });

export function checkCoordinates(property, runs = 1000) {
  fc.assert(fc.property(coordinate, coordinate, coordinate, (x, y, z) => property({ x, y, z })), {
    numRuns: runs,
    seed: 0x5eed,
  });
}
