// Avatar colours, given by the order people were added to People, so each person keeps theirs everywhere.
const TINTS = ["#0E7C7B", "#7A49E8", "#18794E", "#0891B2", "#0F766E", "#0369A1", "#B45309", "#C7302C", "#B85C14", "#4F46E5", "#0F766E", "#9333EA", "#0369A1", "#B85C14"];

export const tintAt = (index: number) => TINTS[((index % TINTS.length) + TINTS.length) % TINTS.length]!;
