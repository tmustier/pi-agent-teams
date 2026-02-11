const SONNET4_DEPRECATED_MARKER = "claude-sonnet-4";
const SONNET45_ALLOWED_MARKERS = ["claude-sonnet-4-5", "claude-sonnet-4.5"];

function normalizeModelId(modelId: string): string {
	return modelId.trim().toLowerCase();
}

function hasAnyMarker(value: string, markers: readonly string[]): boolean {
	for (const marker of markers) {
		if (value.includes(marker)) return true;
	}
	return false;
}

export function isDeprecatedTeammateModelId(modelId: string): boolean {
	const normalized = normalizeModelId(modelId);
	if (!normalized) return false;
	if (!normalized.includes(SONNET4_DEPRECATED_MARKER)) return false;
	if (hasAnyMarker(normalized, SONNET45_ALLOWED_MARKERS)) return false;

	const idx = normalized.indexOf(SONNET4_DEPRECATED_MARKER);
	const next = normalized.at(idx + SONNET4_DEPRECATED_MARKER.length);
	if (!next) return true;
	return next === "-" || next === "_" || next === "." || next === ":";
}
