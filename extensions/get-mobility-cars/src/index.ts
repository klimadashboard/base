import type { Router, Request, Response } from "express";
import type { EndpointExtensionContext } from "@directus/extensions";
import crypto from "node:crypto";

type Layer = "municipality" | "district";
type Country = "AT" | "DE";

type RegionRow = {
	id: string;
	name?: string;
	code?: string;
	code_short?: string;
	layer: Layer;
	country: Country;
	parents?: Array<{ id: string; layer: string }>;
};

type MobilityRow = {
	region: string; // code or code_short (matches one of regions.code / regions.code_short)
	period: string; // year as string
	category: string; // "Antriebsart" label (Benzin, Diesel, Elektro, ...)
	value: number; // numeric value
	country: Country;
	source?: string;
};

function normalizeStr(s?: string | null) {
	return (s ?? "").trim();
}

function groupByYearAndCategory(rows: MobilityRow[]) {
	// { [year]: { [category]: number } }
	const out: Record<string, Record<string, number>> = {};
	for (const r of rows) {
		if (!out[r.period]) out[r.period] = {};
		out[r.period][r.category] =
			(out[r.period][r.category] ?? 0) + (r.value ?? 0);
	}
	return out;
}

function unique<T>(arr: T[]): T[] {
	return [...new Set(arr)];
}

function collectSources(rows: MobilityRow[]): string {
	const sources = unique(rows.map((r) => r.source).filter(Boolean) as string[]);
	return sources.join(", ");
}

/* ------------------------- 🧠 Tiny in-memory cache ------------------------- */

type CacheEntry = {
	etag: string;
	body: any;
	status: number;
	expiresAt: number;
	cacheControl: string;
};

const CACHE = new Map<string, CacheEntry>();
const INFLIGHT = new Map<
	string,
	Promise<{ body: any; status: number; cacheControl: string }>
>();

// tune these if you like
const SUCCESS_TTL_MS = 300 * 1000; // 5 min
const ERROR_TTL_MS = 60 * 1000; // 1 min
const STALE_WHILE_REVALIDATE_S = 60;

function cacheKey(req: Request) {
	const region = normalizeStr(req.query.region as string | undefined);
	const layer = normalizeStr(req.query.layer as string | undefined);
	const country = normalizeStr(
		(req.query.country as string | undefined)?.toUpperCase()
	);
	const includeMeta = (req.query.includeMeta as string) === "true" ? "1" : "0";
	return `get-mobility-cars|r=${region}|l=${layer}|c=${country}|m=${includeMeta}`;
}

function mkEtag(body: any) {
	const json = typeof body === "string" ? body : JSON.stringify(body);
	return `"W/${crypto.createHash("sha1").update(json).digest("hex")}"`;
}

async function sendCached(
	req: Request,
	res: Response,
	key: string,
	compute: () => Promise<{ body: any; status?: number; cacheForMs?: number }>
) {
	const bypass = (req.query.refresh as string) === "true";

	// Serve from cache (if valid & not bypassed)
	const cached = !bypass ? CACHE.get(key) : undefined;
	const now = Date.now();
	if (cached && cached.expiresAt > now) {
		// ETag revalidation
		const inm = req.headers["if-none-match"];
		if (inm && inm === cached.etag) {
			res.setHeader("ETag", cached.etag);
			res.setHeader("Cache-Control", cached.cacheControl);
			return res.status(304).end();
		}
		res.setHeader("ETag", cached.etag);
		res.setHeader("Cache-Control", cached.cacheControl);
		return res.status(cached.status).json(cached.body);
	}

	// Single-flight: coalesce identical concurrent requests
	if (INFLIGHT.has(key)) {
		const result = await INFLIGHT.get(key)!;
		const etag = mkEtag(result.body);
		const entry: CacheEntry = {
			etag,
			body: result.body,
			status: result.status,
			expiresAt:
				Date.now() + (result.status === 200 ? SUCCESS_TTL_MS : ERROR_TTL_MS),
			cacheControl:
				result.cacheControl ||
				(result.status === 200
					? `public, max-age=${Math.floor(
							SUCCESS_TTL_MS / 1000
					  )}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_S}`
					: `public, max-age=${Math.floor(ERROR_TTL_MS / 1000)}`),
		};
		CACHE.set(key, entry);
		res.setHeader("ETag", entry.etag);
		res.setHeader("Cache-Control", entry.cacheControl);
		return res.status(entry.status).json(entry.body);
	}

	// Compute and cache
	const p = (async () => {
		const { body, status = 200, cacheForMs } = await compute();
		const etag = mkEtag(body);
		const cacheControl =
			status === 200
				? `public, max-age=${Math.floor(
						(cacheForMs ?? SUCCESS_TTL_MS) / 1000
				  )}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_S}`
				: `public, max-age=${Math.floor((cacheForMs ?? ERROR_TTL_MS) / 1000)}`;

		const entry: CacheEntry = {
			etag,
			body,
			status,
			expiresAt:
				Date.now() +
				(cacheForMs ?? (status === 200 ? SUCCESS_TTL_MS : ERROR_TTL_MS)),
			cacheControl,
		};
		CACHE.set(key, entry);
		return { body, status, cacheControl };
	})();

	INFLIGHT.set(key, p);
	try {
		const result = await p;
		const final = CACHE.get(key)!;
		res.setHeader("ETag", final.etag);
		res.setHeader("Cache-Control", final.cacheControl);
		return res.status(final.status).json(final.body);
	} finally {
		INFLIGHT.delete(key);
	}
}

/* ------------------------------------------------------------------------- */

export default {
	id: "get-mobility-cars",
	handler: (
		router: Router,
		{ services, database, getSchema }: EndpointExtensionContext
	) => {
		const { ItemsService } = services;

		router.get("/", async (req: Request, res: Response) => {
			const regionParam = normalizeStr(req.query.region as string | undefined);
			const layerParam = normalizeStr(req.query.layer as string | undefined) as
				| Layer
				| "";
			const countryParam = normalizeStr(
				req.query.country as string | undefined
			).toUpperCase() as Country | "";
			const returnMeta = (req.query.includeMeta as string) === "true";

			const key = cacheKey(req);

			return sendCached(req, res, key, async () => {
				try {
					const schema = await getSchema();
					const regionsService = new ItemsService("regions", {
						database,
						schema,
					});
					const carsService = new ItemsService("mobility_cars", {
						database,
						schema,
					});

					// --- Helper: resolve a region by id / code / code_short
					const resolveRegion = async (
						key: string
					): Promise<RegionRow | null> => {
						const [byId, byCode, byCodeShort] = await Promise.all([
							regionsService.readByQuery({
								filter: { id: { _eq: key } },
								fields: [
									"id",
									"name",
									"code",
									"code_short",
									"layer",
									"country",
									"parents",
								],
								limit: 1,
								deep: { parents: true },
							}),
							regionsService.readByQuery({
								filter: { code: { _eq: key } },
								fields: [
									"id",
									"name",
									"code",
									"code_short",
									"layer",
									"country",
									"parents",
								],
								limit: 1,
								deep: { parents: true },
							}),
							regionsService.readByQuery({
								filter: { code_short: { _eq: key } },
								fields: [
									"id",
									"name",
									"code",
									"code_short",
									"layer",
									"country",
									"parents",
								],
								limit: 1,
								deep: { parents: true },
							}),
						]);
						return (
							(byId?.[0] as RegionRow) ||
							(byCode?.[0] as RegionRow) ||
							(byCodeShort?.[0] as RegionRow) ||
							null
						);
					};

					// --- Helper: fetch cars for a set of region codes (code OR code_short) and optional country
					const fetchCarsForRegionCodes = async (
						codes: string[],
						country?: Country
					) => {
						if (!codes.length) return [] as MobilityRow[];
						const filterBase: any[] = [{ _or: [{ region: { _in: codes } }] }];
						if (country) filterBase.push({ country: { _eq: country } });
						const rows = await carsService.readByQuery({
							filter: { _and: filterBase },
							fields: [
								"region",
								"period",
								"category",
								"value",
								"country",
								"source",
							],
							limit: -1,
						});
						return (rows || []) as MobilityRow[];
					};

					// --- Helper: find child municipalities of ANY region
					// This handles various region structures:
					// - Regular districts containing municipalities
					// - Vienna (layer: "state") which contains 23 Bezirke as municipalities
					// - Other city-states with similar structures
					const findChildMunicipalities = async (
						parentId: string,
						country?: Country,
						parentName?: string
					) => {
						const filter: any = { layer: { _eq: "municipality" } };
						if (country) filter.country = { _eq: country };
						const munis = (await regionsService.readByQuery({
							filter,
							fields: [
								"id",
								"name",
								"code",
								"code_short",
								"layer",
								"country",
								"parents",
							],
							limit: -1,
							deep: { parents: true },
						})) as RegionRow[];

						// Find municipalities that have the given region as ANY parent
						// (regardless of the parent's layer - handles Vienna as "state",
						// districts as "district", etc.)
						// IMPORTANT: Exclude municipalities with the same name as the parent
						// to avoid including aggregate/total entries (e.g., Wien 90001 should
						// not be included when aggregating Vienna state - it represents old
						// aggregate data, not a separate district)
						return munis.filter(
							(m) =>
								Array.isArray(m.parents) &&
								m.parents.some((p) => p.id === parentId) &&
								// Exclude same-name municipalities to avoid double-counting
								(!parentName ||
									normalizeStr(m.name)?.toLowerCase() !==
										normalizeStr(parentName)?.toLowerCase())
						);
					};

					// ============================================================
					// MODE A: region=<id|code|code_short>
					// ============================================================
					if (regionParam) {
						const region = await resolveRegion(regionParam);
						if (!region) {
							return {
								body: { error: `Region not found: '${regionParam}'` },
								status: 404,
								cacheForMs: ERROR_TTL_MS,
							};
						}

						const regionCodes = unique(
							[region.code, region.code_short].filter(Boolean) as string[]
						);
						const directRows = await fetchCarsForRegionCodes(
							regionCodes,
							region.country
						);

						if (region.layer === "municipality") {
							if (directRows.length === 0) {
								return {
									body: {
										error:
											"No municipality-level data available for this region; only higher-level data exists.",
										details: {
											requested_region: {
												id: region.id,
												code: region.code,
												code_short: region.code_short,
											},
										},
									},
									status: 400,
									cacheForMs: ERROR_TTL_MS,
								};
							}
							const data = groupByYearAndCategory(directRows);
							return {
								body: {
									region: returnMeta
										? {
												id: region.id,
												name: region.name,
												layer: region.layer,
												country: region.country,
												code: region.code,
												code_short: region.code_short,
										  }
										: { id: region.id },
									data,
									source: collectSources(directRows),
								},
							};
						}

						// district (or bundesland that acts as district, like Vienna)
						if (directRows.length > 0) {
							const data = groupByYearAndCategory(directRows);
							return {
								body: {
									region: returnMeta
										? {
												id: region.id,
												name: region.name,
												layer: region.layer,
												country: region.country,
												code: region.code,
												code_short: region.code_short,
										  }
										: { id: region.id },
									data,
									source: collectSources(directRows),
								},
							};
						}

						// aggregate from municipalities
						const munis = await findChildMunicipalities(
							region.id,
							region.country,
							region.name // Pass parent name to exclude same-name municipalities
						);
						const muniCodes = unique(
							munis.flatMap(
								(m) => [m.code, m.code_short].filter(Boolean) as string[]
							)
						);
						if (muniCodes.length === 0) {
							return {
								body: {
									error:
										"No municipalities found under this district to aggregate.",
									details: { requested_region: region.id },
								},
								status: 404,
								cacheForMs: ERROR_TTL_MS,
							};
						}

						const muniRows = await fetchCarsForRegionCodes(
							muniCodes,
							region.country
						);
						if (muniRows.length === 0) {
							return {
								body: {
									error: "No data found for municipalities of this district.",
									details: { requested_region: region.id },
								},
								status: 404,
								cacheForMs: ERROR_TTL_MS,
							};
						}

						const data = groupByYearAndCategory(muniRows);
						return {
							body: {
								region: returnMeta
									? {
											id: region.id,
											name: region.name,
											layer: region.layer,
											country: region.country,
											code: region.code,
											code_short: region.code_short,
									  }
									: { id: region.id },
								aggregated_from: "municipalities",
								data,
								source: collectSources(muniRows),
							},
						};
					}

					// ============================================================
					// MODE B: layer=<municipality|district>&country=<AT|DE>
					// ============================================================
					if (
						!layerParam ||
						!["municipality", "district"].includes(layerParam)
					) {
						return {
							body: { error: "Missing or invalid 'layer' parameter" },
							status: 400,
							cacheForMs: ERROR_TTL_MS,
						};
					}
					if (!countryParam || !["AT", "DE"].includes(countryParam)) {
						return {
							body: { error: "Missing or invalid 'country' parameter" },
							status: 400,
							cacheForMs: ERROR_TTL_MS,
						};
					}

					const allRegions = (await regionsService.readByQuery({
						filter: {
							layer: { _eq: layerParam },
							country: { _eq: countryParam },
						},
						fields: [
							"id",
							"name",
							"code",
							"code_short",
							"layer",
							"country",
							"parents",
						],
						limit: -1,
						deep: { parents: true },
					})) as RegionRow[];

					let muniByDistrict: Record<string, RegionRow[]> = {};
					let muniCodesAll: string[] = [];

					if (layerParam === "district") {
						const allMunicipalities = (await regionsService.readByQuery({
							filter: {
								layer: { _eq: "municipality" },
								country: { _eq: countryParam },
							},
							fields: [
								"id",
								"name",
								"code",
								"code_short",
								"layer",
								"country",
								"parents",
							],
							limit: -1,
							deep: { parents: true },
						})) as RegionRow[];

						// Create a lookup of parent names by ID for filtering
						const parentNameById: Record<string, string> = {};
						for (const r of allRegions) {
							parentNameById[r.id] = normalizeStr(r.name)?.toLowerCase() || "";
						}

						// Group municipalities by their parent region ID
						// Don't filter by parent layer - handles Vienna (state), districts, etc.
						// IMPORTANT: Exclude municipalities with the same name as their parent
						// to avoid including aggregate/total entries (e.g., Wien 90001)
						muniByDistrict = allMunicipalities.reduce((acc, m) => {
							const muniNameLower = normalizeStr(m.name)?.toLowerCase() || "";
							for (const p of m.parents || []) {
								// Skip if municipality has the same name as parent (aggregate entry)
								const parentNameLower = parentNameById[p.id];
								if (parentNameLower && muniNameLower === parentNameLower) {
									continue;
								}
								// Add municipality to this parent
								(acc[p.id] ||= []).push(m);
							}
							return acc;
						}, {} as Record<string, RegionRow[]>);

						muniCodesAll = unique(
							allRegions
								.flatMap((d) => muniByDistrict[d.id] || [])
								.flatMap(
									(m) => [m.code, m.code_short].filter(Boolean) as string[]
								)
						);
					}

					const allDistrictCodes = unique(
						allRegions.flatMap(
							(r) => [r.code, r.code_short].filter(Boolean) as string[]
						)
					);
					const combinedCodes =
						layerParam === "district"
							? unique([...allDistrictCodes, ...muniCodesAll])
							: allDistrictCodes;

					const allRows = (await carsService.readByQuery({
						filter: {
							_and: [
								{ region: { _in: combinedCodes } },
								{ country: { _eq: countryParam } },
							],
						},
						fields: [
							"region",
							"period",
							"category",
							"value",
							"country",
							"source",
						],
						limit: -1,
					})) as MobilityRow[];

					const rowsByCode = new Map<string, MobilityRow[]>();
					for (const row of allRows) {
						if (!rowsByCode.has(row.region)) rowsByCode.set(row.region, []);
						rowsByCode.get(row.region)!.push(row);
					}

					const result: any[] = [];

					for (const r of allRegions) {
						const myCodes = unique(
							[r.code, r.code_short].filter(Boolean) as string[]
						);
						const direct = myCodes.flatMap((c) => rowsByCode.get(c) || []);

						if (direct.length > 0 || layerParam === "municipality") {
							result.push({
								region: returnMeta
									? {
											id: r.id,
											name: r.name,
											layer: r.layer,
											country: r.country,
											code: r.code,
											code_short: r.code_short,
									  }
									: { id: r.id },
								data: groupByYearAndCategory(direct),
								source: collectSources(direct),
							});
							continue;
						}

						const munis = muniByDistrict[r.id] || [];
						const muniCodes = unique(
							munis.flatMap(
								(m) => [m.code, m.code_short].filter(Boolean) as string[]
							)
						);
						const muniRows = muniCodes.flatMap((c) => rowsByCode.get(c) || []);

						result.push({
							region: returnMeta
								? {
										id: r.id,
										name: r.name,
										layer: r.layer,
										country: r.country,
										code: r.code,
										code_short: r.code_short,
								  }
								: { id: r.id },
							aggregated_from: "municipalities",
							data: groupByYearAndCategory(muniRows),
							source: collectSources(muniRows),
						});
					}

					return { body: result }; // 200 cached
				} catch (err: any) {
					console.error(err);
					return {
						body: { error: "Internal Server Error", details: err.message },
						status: 500,
						cacheForMs: 0, // don't cache 500s
					};
				}
			});
		});
	},
};
