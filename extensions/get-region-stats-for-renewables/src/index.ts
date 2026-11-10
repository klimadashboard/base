import { Router, Request, Response } from "express";

type KnexLike = any;

type RowOut = {
	region: string; // always code_short || code
	population: number | null;
	area_km2: number | null;
	unit_count: number;
	total_power_kw: number;
	power_per_area_kw_per_km2: number | null;
	power_per_capita_kw_per_person: number | null;
};

const ONE_HOUR_MS = 36e5;
const TABLES = ["energy_solar_units", "energy_wind_units"] as const;
const LEVELS = ["municipality", "district", "state", "country"] as const;

const FIELDS = {
	id: "id",
	code_short: "code_short",
	code: "code",
	pop: "population",
	area: "area",
	layer: "layer",
	parents: "parents", // JSON array: [{ id, layer }]
} as const;

const normCode = (row: { code_short?: string | null; code?: string | null }) =>
	(row.code_short && String(row.code_short).trim()) ||
	(row.code && String(row.code).trim()) ||
	null;

function finalizeRow(v: {
	region: string;
	population: number | null;
	area_km2: number | null;
	unit_count: number;
	total_power_kw: number;
}): RowOut {
	const ppa =
		v.area_km2 && v.area_km2 > 0
			? +(v.total_power_kw / v.area_km2).toFixed(2)
			: null;
	const ppc =
		v.population && v.population > 0
			? +(v.total_power_kw / v.population).toFixed(4)
			: null;

	return {
		region: v.region,
		population: v.population ?? null,
		area_km2: v.area_km2 ?? null,
		unit_count: v.unit_count,
		total_power_kw: v.total_power_kw,
		power_per_area_kw_per_km2: ppa,
		power_per_capita_kw_per_person: ppc,
	};
}

async function fetchRegionsMetaByKeys(
	database: KnexLike,
	keys: Set<string>,
	layer?: "district" | "state" | "municipality"
): Promise<
	Map<string, { population: number | null; area_km2: number | null }>
> {
	const out = new Map<
		string,
		{ population: number | null; area_km2: number | null }
	>();
	if (keys.size === 0) return out;

	const all = Array.from(keys);
	const CHUNK = 500;

	for (let i = 0; i < all.length; i += CHUNK) {
		const slice = all.slice(i, i + CHUNK);
		const q = database("regions")
			.select(
				`${FIELDS.code_short} as code_short`,
				`${FIELDS.code} as code`,
				`${FIELDS.pop} as population`,
				`${FIELDS.area} as area`,
				`${FIELDS.layer} as layer`
			)
			.where((qb: any) => {
				qb.whereIn(FIELDS.code_short, slice).orWhereIn(FIELDS.code, slice);
			});
		if (layer) q.andWhere(FIELDS.layer, layer);

		const rows = await q;
		for (const r of rows) {
			const key = normCode(r);
			if (!key) continue;
			out.set(key, {
				population: r.population ?? null,
				area_km2: r.area ?? null,
			});
		}
	}
	return out;
}

let cache: {
	table: string;
	level: string;
	timestamp: number;
	data: RowOut[];
} | null = null;

export default {
	id: "get-region-stats-for-renewables",
	handler: (router: Router, { database }: { database: KnexLike }) => {
		router.get("/", async (req: Request, res: Response) => {
			try {
				const table = String(req.query.table || "");
				const level = String(req.query.level || "municipality").toLowerCase();

				if (!TABLES.includes(table as any)) {
					return res.status(400).json({
						error:
							"Missing or invalid table. Use ?table=energy_solar_units or energy_wind_units",
					});
				}
				if (!LEVELS.includes(level as any)) {
					return res.status(400).json({
						error:
							"Invalid level. Use ?level=municipality|district|state|country",
					});
				}

				if (
					cache &&
					cache.table === table &&
					cache.level === level &&
					Date.now() - cache.timestamp < ONE_HOUR_MS
				) {
					return res.json(cache.data);
				}

				const cutoffDate = `${new Date().getFullYear()}-12-31`;

				// 1) Municipality codes present in energy table (these should be code_short, but we’ll be robust)
				const muniCodes: string[] = (
					await database(table)
						.select("region")
						.whereNotNull("region")
						.groupBy("region")
				).map((r: any) => String(r.region));

				if (muniCodes.length === 0) {
					cache = { table, level, timestamp: Date.now(), data: [] };
					return res.json([]);
				}

				// 2) Load municipality rows incl. parents JSON, matching on code_short OR code
				const muniRows: any[] = await (async () => {
					const results: any[] = [];
					const CHUNK = 500;
					for (let i = 0; i < muniCodes.length; i += CHUNK) {
						const slice = muniCodes.slice(i, i + CHUNK);
						const rows = await database("regions")
							.select(
								`${FIELDS.id} as id`,
								`${FIELDS.code_short} as code_short`,
								`${FIELDS.code} as code`,
								`${FIELDS.pop} as population`,
								`${FIELDS.area} as area`,
								`${FIELDS.layer} as layer`,
								`${FIELDS.parents} as parents`
							)
							.where((qb: any) => {
								qb.whereIn(FIELDS.code_short, slice).orWhereIn(
									FIELDS.code,
									slice
								);
							})
							.andWhere(FIELDS.layer, "municipality");
						results.push(...rows);
					}
					return results;
				})();

				// Map: municipality key (code_short||code) -> { pop, area, parentIds }
				const muniMeta = new Map<
					string,
					{
						population: number | null;
						area_km2: number | null;
						district_parent_id: string | null;
						state_parent_id: string | null;
					}
				>();

				// Collect parent IDs to resolve later
				const districtParentIds = new Set<string>();
				const stateParentIds = new Set<string>();

				for (const r of muniRows) {
					const muniKey = normCode(r);
					if (!muniKey) continue;

					// parents is expected to be an array like [{ id, layer }]
					const parents: Array<{ id: string; layer: string }> = Array.isArray(
						r.parents
					)
						? r.parents
						: [];

					const districtParent = parents.find(
						(p) => p && p.layer === "district"
					);
					const stateParent = parents.find((p) => p && p.layer === "state");

					const district_parent_id = districtParent?.id ?? null;
					const state_parent_id = stateParent?.id ?? null;

					if (district_parent_id) districtParentIds.add(district_parent_id);
					if (state_parent_id) stateParentIds.add(state_parent_id);

					muniMeta.set(muniKey, {
						population: r.population ?? null,
						area_km2: r.area ?? null,
						district_parent_id,
						state_parent_id,
					});
				}

				// 3) Resolve parent IDs -> parent keys (code_short||code) & meta (population, area)
				async function resolveParentIdMap(
					ids: Set<string>,
					layer: "district" | "state"
				) {
					const out = new Map<
						string,
						{ key: string; population: number | null; area_km2: number | null }
					>(); // parent_id -> { key, meta }

					if (ids.size === 0) return out;

					const all = Array.from(ids);
					const CHUNK = 500;
					for (let i = 0; i < all.length; i += CHUNK) {
						const slice = all.slice(i, i + CHUNK);
						const rows = await database("regions")
							.select(
								`${FIELDS.id} as id`,
								`${FIELDS.code_short} as code_short`,
								`${FIELDS.code} as code`,
								`${FIELDS.pop} as population`,
								`${FIELDS.area} as area`,
								`${FIELDS.layer} as layer`
							)
							.whereIn(FIELDS.id, slice)
							.andWhere(FIELDS.layer, layer);

						for (const r of rows) {
							const key = normCode(r);
							if (!key) continue;
							out.set(String(r.id), {
								key,
								population: r.population ?? null,
								area_km2: r.area ?? null,
							});
						}
					}
					return out;
				}

				const districtIdMap = await resolveParentIdMap(
					districtParentIds,
					"district"
				);
				const stateIdMap = await resolveParentIdMap(stateParentIds, "state");

				// 4) Aggregate energy at municipality level
				const muniAgg = (
					await database(table)
						.select("region")
						.count("id as unit_count")
						.sum("power_kw as total_power_kw")
						.where("commissioning_date", "<=", cutoffDate)
						.andWhere(function (this: any) {
							this.whereNull("shutdown_date").orWhere(
								"shutdown_date",
								">",
								cutoffDate
							);
						})
						.groupBy("region")
				).map((row: any) => {
					const muniKey = String(row.region);
					const unit_count = parseInt(row.unit_count, 10);
					const total_power_kw = row.total_power_kw
						? Math.round(parseFloat(row.total_power_kw))
						: 0;
					const meta = muniMeta.get(muniKey) || {
						population: null,
						area_km2: null,
						district_parent_id: null,
						state_parent_id: null,
					};

					const district_key = meta.district_parent_id
						? districtIdMap.get(meta.district_parent_id)?.key ?? null
						: null;
					const state_key = meta.state_parent_id
						? stateIdMap.get(meta.state_parent_id)?.key ?? null
						: null;

					return {
						muni_key: muniKey,
						population: meta.population,
						area_km2: meta.area_km2,
						unit_count,
						total_power_kw,
						district_key,
						state_key,
					};
				});

				const addCountryHeader = (rows: RowOut[]): RowOut[] => {
					const total_units = rows.reduce((a, b) => a + b.unit_count, 0);
					const total_power = rows.reduce((a, b) => a + b.total_power_kw, 0);
					return [
						{
							region: "country",
							population: null,
							area_km2: null,
							unit_count: total_units,
							total_power_kw: total_power,
							power_per_area_kw_per_km2: null,
							power_per_capita_kw_per_person: null,
						},
						...rows,
					];
				};

				let out: RowOut[] = [];

				if (level === "municipality") {
					// One row per municipality (using municipality pop/area directly)
					out = muniAgg.map((r) =>
						finalizeRow({
							region: r.muni_key,
							population: r.population,
							area_km2: r.area_km2,
							unit_count: r.unit_count,
							total_power_kw: r.total_power_kw,
						})
					);
					out = addCountryHeader(out);
				} else if (level === "district" || level === "state") {
					// Roll up energy to parent keys
					const getKey =
						level === "district"
							? (r: any) => r.district_key
							: (r: any) => r.state_key;

					const energyByKey = new Map<
						string,
						{ unit_count: number; total_power_kw: number }
					>();
					for (const r of muniAgg) {
						const key = getKey(r);
						if (!key) continue;
						const cur = energyByKey.get(key) || {
							unit_count: 0,
							total_power_kw: 0,
						};
						cur.unit_count += r.unit_count;
						cur.total_power_kw += r.total_power_kw;
						energyByKey.set(key, cur);
					}

					// Fetch pop/area directly from regions for the target layer keys
					const layerMeta = await fetchRegionsMetaByKeys(
						database,
						new Set(energyByKey.keys()),
						level as "district" | "state"
					);

					out = Array.from(energyByKey.entries()).map(([key, val]) =>
						finalizeRow({
							region: key, // always code_short || code
							population: layerMeta.get(key)?.population ?? null,
							area_km2: layerMeta.get(key)?.area_km2 ?? null,
							unit_count: val.unit_count,
							total_power_kw: val.total_power_kw,
						})
					);

					out = addCountryHeader(out);
				} else if (level === "country") {
					// National rollup
					const total_units = muniAgg.reduce((a, b) => a + b.unit_count, 0);
					const total_power = muniAgg.reduce((a, b) => a + b.total_power_kw, 0);
					out = [
						{
							region: "country",
							population: null,
							area_km2: null,
							unit_count: total_units,
							total_power_kw: total_power,
							power_per_area_kw_per_km2: null,
							power_per_capita_kw_per_person: null,
						},
					];
				}

				cache = { table, level, timestamp: Date.now(), data: out };
				return res.json(out);
			} catch (err: any) {
				console.error(err);
				return res.status(500).json({
					error: "Failed to fetch region stats",
					details: err.message,
				});
			}
		});
	},
};
