import { Router, Request, Response } from "express";
import { LRUCache } from "lru-cache";

const TABLE = "energy_storage_units";

// LRU cache: up to 200 entries, 6-hour TTL
const cache = new LRUCache<string, any>({
	max: 200,
	ttl: 1000 * 60 * 60 * 6,
});

function isUUID(str: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		str
	);
}

async function resolveRegionCodes(
	database: any,
	regionInput: string,
	country: string
): Promise<{ codes: string[]; usePrefix: boolean; prefix: string | null }> {
	const includeId = isUUID(regionInput);

	let regionRow = await database("regions")
		.select("id", "code_short", "code", "layer", "country")
		.where((qb: any) => {
			if (includeId) {
				qb.where("id", regionInput)
					.orWhere("code_short", regionInput)
					.orWhere("code", regionInput);
			} else {
				qb.where("code_short", regionInput).orWhere("code", regionInput);
			}
		})
		.andWhere("country", country.toUpperCase())
		.first();

	if (!regionRow) {
		regionRow = await database("regions")
			.select("id", "code_short", "code", "layer", "country")
			.where((qb: any) => {
				if (includeId) {
					qb.where("id", regionInput)
						.orWhere("code_short", regionInput)
						.orWhere("code", regionInput);
				} else {
					qb.where("code_short", regionInput).orWhere(
						"code",
						regionInput
					);
				}
			})
			.first();
	}

	if (!regionRow) {
		if (regionInput.length < 8) {
			return { codes: [], usePrefix: true, prefix: regionInput };
		}
		return { codes: [regionInput], usePrefix: false, prefix: null };
	}

	const regionCode = regionRow.code_short || regionRow.code;

	if (regionRow.country === "DE" && regionCode) {
		const layer: string = regionRow.layer;
		if (layer === "state") {
			return {
				codes: [],
				usePrefix: true,
				prefix: String(regionCode).slice(0, 2),
			};
		} else if (layer === "district") {
			return {
				codes: [],
				usePrefix: true,
				prefix: String(regionCode).slice(0, 5),
			};
		} else if (layer === "municipality") {
			return {
				codes: [regionRow.code_short, regionRow.code].filter(Boolean),
				usePrefix: false,
				prefix: null,
			};
		}
	}

	return {
		codes: [regionRow.code_short, regionRow.code].filter(Boolean),
		usePrefix: false,
		prefix: null,
	};
}

// Several comma-separated regions (e.g. the 34 districts of the Metropolregion
// Nürnberg) are resolved one by one and summed.
async function resolveRegionList(
	database: any,
	regionInput: string,
	country: string
): Promise<{ codes: string[]; usePrefix: boolean; prefix: string | null; prefixes?: string[] }> {
	const inputs = regionInput.split(",").map((s) => s.trim()).filter(Boolean);
	if (inputs.length <= 1) return resolveRegionCodes(database, inputs[0] ?? regionInput, country);
	const merged = { codes: [] as string[], usePrefix: false, prefix: null, prefixes: [] as string[] };
	for (const input of inputs) {
		const resolved = await resolveRegionCodes(database, input, country);
		if (resolved.usePrefix && resolved.prefix) merged.prefixes.push(resolved.prefix);
		else merged.codes.push(...resolved.codes);
	}
	return merged;
}

function applyRegionFilter(
	query: any,
	resolved: { codes: string[]; usePrefix: boolean; prefix: string | null; prefixes?: string[] }
): void {
	if (resolved.prefixes?.length) {
		query.andWhere((qb: any) => {
			for (const prefix of resolved.prefixes!) qb.orWhere("region", "like", `${prefix}%`);
			if (resolved.codes.length) qb.orWhereIn("region", resolved.codes);
		});
		return;
	}
	if (resolved.usePrefix && resolved.prefix) {
		query.andWhere("region", "like", `${resolved.prefix}%`);
	} else if (resolved.codes.length === 1) {
		query.andWhere("region", resolved.codes[0]);
	} else if (resolved.codes.length > 1) {
		query.whereIn("region", resolved.codes);
	}
}

// ────────────────────────────────────────────────
// group=year   → yearly growth by category
// group=month  → monthly growth by category
// ────────────────────────────────────────────────
async function handleTimeSeries(
	database: any,
	group: "year" | "month",
	country: string,
	resolvedRegion: {
		codes: string[];
		usePrefix: boolean;
		prefix: string | null;
	} | null
): Promise<any> {
	const now = new Date().toISOString();

	const extractExpr =
		group === "year"
			? "EXTRACT(YEAR FROM commissioning_date)::int"
			: "TO_CHAR(commissioning_date, 'YYYY-MM')";
	const extractShutdownExpr =
		group === "year"
			? "EXTRACT(YEAR FROM shutdown_date)::int"
			: "TO_CHAR(shutdown_date, 'YYYY-MM')";

	// Commissioned by period + category
	const addedQuery = database(TABLE)
		.select(
			database.raw(`${extractExpr} as period`),
			"category",
			database.raw("SUM(power_kw) as added_power_kw"),
			database.raw(
				"SUM(usable_storage_capacity_kwh) as added_capacity_kwh"
			),
			database.raw("COUNT(*) as added_units")
		)
		.whereNotNull("commissioning_date")
		.andWhere("commissioning_date", "<=", now)
		.andWhere("country", country);

	if (resolvedRegion) applyRegionFilter(addedQuery, resolvedRegion);

	const addedRaw = await addedQuery
		.groupBy("period", "category")
		.orderBy("period", "asc");

	// Shutdown by period + category
	const removedQuery = database(TABLE)
		.select(
			database.raw(`${extractShutdownExpr} as period`),
			"category",
			database.raw("SUM(power_kw) as removed_power_kw"),
			database.raw(
				"SUM(usable_storage_capacity_kwh) as removed_capacity_kwh"
			),
			database.raw("COUNT(*) as removed_units")
		)
		.whereNotNull("shutdown_date")
		.andWhere("country", country);

	if (resolvedRegion) applyRegionFilter(removedQuery, resolvedRegion);

	const removedRaw = await removedQuery
		.groupBy("period", "category")
		.orderBy("period", "asc");

	// Build lookup maps: period → category → values
	type PeriodData = {
		addedPower: number;
		addedCapacity: number;
		addedUnits: number;
		removedPower: number;
		removedCapacity: number;
		removedUnits: number;
	};
	const dataMap = new Map<string, Map<string, PeriodData>>();
	const allCategories = new Set<string>();

	for (const row of addedRaw) {
		const period = String(row.period);
		const cat: string = row.category || "Unbekannt";
		allCategories.add(cat);
		if (!dataMap.has(period)) dataMap.set(period, new Map());
		const catMap = dataMap.get(period)!;
		catMap.set(cat, {
			addedPower: parseFloat(row.added_power_kw) || 0,
			addedCapacity: parseFloat(row.added_capacity_kwh) || 0,
			addedUnits: parseInt(row.added_units, 10) || 0,
			removedPower: 0,
			removedCapacity: 0,
			removedUnits: 0,
		});
	}

	for (const row of removedRaw) {
		const period = String(row.period);
		const cat: string = row.category || "Unbekannt";
		allCategories.add(cat);
		if (!dataMap.has(period)) dataMap.set(period, new Map());
		const catMap = dataMap.get(period)!;
		const existing = catMap.get(cat) || {
			addedPower: 0,
			addedCapacity: 0,
			addedUnits: 0,
			removedPower: 0,
			removedCapacity: 0,
			removedUnits: 0,
		};
		existing.removedPower = parseFloat(row.removed_power_kw) || 0;
		existing.removedCapacity = parseFloat(row.removed_capacity_kwh) || 0;
		existing.removedUnits = parseInt(row.removed_units, 10) || 0;
		catMap.set(cat, existing);
	}

	// Generate gap-filled time series
	const sortedPeriods = Array.from(dataMap.keys()).sort();
	if (sortedPeriods.length === 0) {
		return { by_period: [], categories: [] };
	}

	let allPeriods: string[];

	if (group === "year") {
		const startYear = 2000;
		const endYear = new Date().getFullYear();

		// Accumulate pre-start values
		const preCumulative = new Map<
			string,
			{ power: number; capacity: number; units: number }
		>();
		for (const cat of allCategories) {
			preCumulative.set(cat, { power: 0, capacity: 0, units: 0 });
		}
		for (const [period, catMap] of dataMap) {
			if (parseInt(period, 10) < startYear) {
				for (const [cat, d] of catMap) {
					const cum = preCumulative.get(cat) || {
						power: 0,
						capacity: 0,
						units: 0,
					};
					cum.power += d.addedPower - d.removedPower;
					cum.capacity += d.addedCapacity - d.removedCapacity;
					cum.units += d.addedUnits - d.removedUnits;
					preCumulative.set(cat, cum);
				}
			}
		}

		allPeriods = [];
		for (let y = startYear; y <= endYear; y++) allPeriods.push(String(y));

		// Build cumulative series
		const cumulative = new Map<
			string,
			{ power: number; capacity: number; units: number }
		>();
		for (const [cat, pre] of preCumulative) {
			cumulative.set(cat, { ...pre });
		}

		const result: any[] = [];
		for (const period of allPeriods) {
			const entry: any = { period: parseInt(period, 10) };
			const catMap = dataMap.get(period);

			for (const cat of allCategories) {
				const d = catMap?.get(cat);
				const added_power = d?.addedPower ?? 0;
				const added_capacity = d?.addedCapacity ?? 0;
				const added_units = d?.addedUnits ?? 0;
				const removed_power = d?.removedPower ?? 0;
				const removed_capacity = d?.removedCapacity ?? 0;
				const removed_units = d?.removedUnits ?? 0;

				const cum = cumulative.get(cat) || {
					power: 0,
					capacity: 0,
					units: 0,
				};
				cum.power += added_power - removed_power;
				cum.capacity += added_capacity - removed_capacity;
				cum.units += added_units - removed_units;
				cumulative.set(cat, cum);

				const prefix = cat.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue");
				entry[`${prefix}_added_power_kw`] = Math.round(added_power - removed_power);
				entry[`${prefix}_added_capacity_kwh`] = Math.round(added_capacity - removed_capacity);
				entry[`${prefix}_added_units`] = added_units - removed_units;
				entry[`${prefix}_cumulative_power_kw`] = Math.round(cum.power);
				entry[`${prefix}_cumulative_capacity_kwh`] = Math.round(
					cum.capacity
				);
				entry[`${prefix}_cumulative_units`] = cum.units;
			}
			result.push(entry);
		}

		return { by_period: result, categories: Array.from(allCategories) };
	}

	// group === "month"
	const firstPeriod = sortedPeriods[0]!;
	const nowDate = new Date();
	const endMonth = `${nowDate.getFullYear()}-${String(nowDate.getMonth() + 1).padStart(2, "0")}`;

	allPeriods = [];
	let cursor = firstPeriod;
	while (cursor <= endMonth) {
		allPeriods.push(cursor);
		const [y, m] = cursor.split("-").map(Number) as [number, number];
		const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
		cursor = next;
	}

	const cumulative = new Map<
		string,
		{ power: number; capacity: number; units: number }
	>();
	for (const cat of allCategories) {
		cumulative.set(cat, { power: 0, capacity: 0, units: 0 });
	}

	const result: any[] = [];
	for (const period of allPeriods) {
		const entry: any = { period };
		const catMap = dataMap.get(period);

		for (const cat of allCategories) {
			const d = catMap?.get(cat);
			const added_power = d?.addedPower ?? 0;
			const added_capacity = d?.addedCapacity ?? 0;
			const added_units = d?.addedUnits ?? 0;
			const removed_power = d?.removedPower ?? 0;
			const removed_capacity = d?.removedCapacity ?? 0;
			const removed_units = d?.removedUnits ?? 0;

			const cum = cumulative.get(cat) || {
				power: 0,
				capacity: 0,
				units: 0,
			};
			cum.power += added_power - removed_power;
			cum.capacity += added_capacity - removed_capacity;
			cum.units += added_units - removed_units;
			cumulative.set(cat, cum);

			const prefix = cat.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue");
			entry[`${prefix}_added_power_kw`] = Math.round(added_power - removed_power);
			entry[`${prefix}_added_capacity_kwh`] = Math.round(added_capacity - removed_capacity);
			entry[`${prefix}_added_units`] = added_units - removed_units;
			entry[`${prefix}_cumulative_power_kw`] = Math.round(cum.power);
			entry[`${prefix}_cumulative_capacity_kwh`] = Math.round(
				cum.capacity
			);
			entry[`${prefix}_cumulative_units`] = cum.units;
		}
		result.push(entry);
	}

	return { by_period: result, categories: Array.from(allCategories) };
}

// ────────────────────────────────────────────────
// group=municipality | group=district
// Current snapshot per region
// ────────────────────────────────────────────────
async function handleRegionSnapshot(
	database: any,
	groupBy: "municipality" | "district",
	country: string
): Promise<any> {
	const now = new Date().toISOString();

	// Determine how to group the region code
	// Municipality: full 8-digit code, District: first 5 digits
	const regionExpr =
		groupBy === "district"
			? "LEFT(region, 5)"
			: "region";

	const query = database(TABLE)
		.select(
			database.raw(`${regionExpr} as region_code`),
			"category",
			database.raw("SUM(power_kw) as power_kw"),
			database.raw(
				"SUM(usable_storage_capacity_kwh) as capacity_kwh"
			),
			database.raw("COUNT(*) as units")
		)
		.whereNotNull("commissioning_date")
		.andWhere("commissioning_date", "<=", now)
		.andWhere("country", country)
		.andWhere((builder: any) =>
			builder
				.whereNull("shutdown_date")
				.orWhere("shutdown_date", ">", now)
		)
		.whereNotNull("region")
		.groupBy("region_code", "category")
		.orderBy("region_code", "asc");

	const rows = await query;

	// Pivot: region_code → { category → stats }
	const regionMap = new Map<string, any>();

	for (const row of rows) {
		const code: string = row.region_code;
		const cat: string = row.category || "Unbekannt";

		if (!regionMap.has(code)) {
			regionMap.set(code, { region: code });
		}
		const entry = regionMap.get(code)!;

		const prefix = cat.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue");
		entry[`${prefix}_power_kw`] = Math.round(parseFloat(row.power_kw) || 0);
		entry[`${prefix}_capacity_kwh`] = Math.round(
			parseFloat(row.capacity_kwh) || 0
		);
		entry[`${prefix}_units`] = parseInt(row.units, 10) || 0;
	}

	return Array.from(regionMap.values());
}

export default {
	id: "get-storage-growth",
	handler: (router: Router, { database }: { database: any }) => {
		router.get("/", async (req: Request, res: Response) => {
			const group = req.query.group as string;
			const country = ((req.query.country as string) || "DE").toUpperCase();
			const region = req.query.region as string | undefined;

			// Validate group parameter
			const validGroups = ["year", "month", "municipality", "district"];
			if (!group || !validGroups.includes(group)) {
				return res.status(400).json({
					error: `Invalid group. Use ?group=${validGroups.join("|")}`,
				});
			}

			const cacheKey = `storage|${group}|${country}|${region || "all"}`;
			const cached = cache.get(cacheKey);
			if (cached) {
				return res.json(cached);
			}

			try {
				if (group === "year" || group === "month") {
					let resolvedRegion: {
						codes: string[];
						usePrefix: boolean;
						prefix: string | null;
					} | null = null;

					if (region) {
						resolvedRegion = await resolveRegionList(
							database,
							region,
							country
						);
					}

					const timeSeries = await handleTimeSeries(
						database,
						group as "year" | "month",
						country,
						resolvedRegion
					);

					// Get last update date
					const updateDateResult = await database(TABLE)
						.whereNotNull("last_update")
						.orderBy("last_update", "desc")
						.first("last_update");

					const result = {
						...timeSeries,
						update_date: updateDateResult?.last_update || null,
					};

					cache.set(cacheKey, result);
					return res.json(result);
				}

				// group === "municipality" or "district"
				const snapshot = await handleRegionSnapshot(
					database,
					group as "municipality" | "district",
					country
				);

				const result = { regions: snapshot };
				cache.set(cacheKey, result);
				return res.json(result);
			} catch (err: any) {
				return res.status(500).json({
					error: "Failed to calculate storage stats",
					details: err.message,
				});
			}
		});
	},
};
