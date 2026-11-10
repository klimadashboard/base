import { Router, Request, Response } from "express";
import { LRUCache } from "lru-cache";

// LRU cache: store up to 100 requests for 6 hours
const cache = new LRUCache<string, any>({
	max: 100,
	ttl: 1000 * 60 * 60 * 6, // 6 hours
});

// Helper to check if a string looks like a UUID
function isUUID(str: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		str
	);
}

// Helper to resolve region codes for filtering
async function resolveRegionCodes(
	database: any,
	regionInput: string,
	country: string
): Promise<{ codes: string[]; usePrefix: boolean; prefix: string | null }> {
	// First, try to find the region in the regions table, prioritizing the requested country
	// Only include id in the search if it looks like a UUID (to avoid PostgreSQL type errors)
	const includeId = isUUID(regionInput);

	// Try with country filter first
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

	// If not found with country filter, try without (for IDs that might not have country)
	if (!regionRow) {
		regionRow = await database("regions")
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
			.first();
	}

	if (!regionRow) {
		// Fallback: treat as a code prefix for backward compatibility
		if (regionInput.length < 8) {
			return { codes: [], usePrefix: true, prefix: regionInput };
		}
		return { codes: [regionInput], usePrefix: false, prefix: null };
	}

	// Get the best available code (prefer code_short, fall back to code)
	const regionCode = regionRow.code_short || regionRow.code;

	// For German regions, use AGS prefix matching based on layer
	if (regionRow.country === "DE" && regionCode) {
		const layer = regionRow.layer;

		if (layer === "state") {
			// German state: use first 2 digits as prefix
			const prefix = String(regionCode).slice(0, 2);
			return { codes: [], usePrefix: true, prefix };
		} else if (layer === "district") {
			// German district: use first 5 digits as prefix
			const prefix = String(regionCode).slice(0, 5);
			return { codes: [], usePrefix: true, prefix };
		} else if (layer === "municipality") {
			// Exact match for municipality
			return {
				codes: [regionRow.code_short, regionRow.code].filter(Boolean),
				usePrefix: false,
				prefix: null,
			};
		}
	}

	// For non-DE regions or fallback: use exact match on code_short/code
	return {
		codes: [regionRow.code_short, regionRow.code].filter(Boolean),
		usePrefix: false,
		prefix: null,
	};
}

// Helper to apply region filter to a query
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
) {
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

function applyOptionalFilters(
	query: any,
	filters: { type?: string; status?: string }
) {
	if (filters.type) query.andWhere("type", filters.type);
	if (filters.status) query.andWhere("status", filters.status);
}

export default {
	id: "get-renewables-growth",
	handler: (router: Router, { database }) => {
		router.get("/", async (req: Request, res: Response) => {
			const now = new Date().toISOString();
			const table = req.query.table as string;
			const group = req.query.group as string;
			const country = (req.query.country as string) || "DE";
			const region = req.query.region as string | undefined;
			const typeFilter = req.query.type as string | undefined;
			const statusFilter = req.query.status as string | undefined;
			const optionalFilters = { type: typeFilter, status: statusFilter };

			if (!["energy_solar_units", "energy_wind_units"].includes(table)) {
				return res.status(400).json({
					error:
						"Invalid table. Use ?table=energy_solar_units or energy_wind_units",
				});
			}

			if (!["year", "month"].includes(group)) {
				return res.status(400).json({
					error: "group must be 'year' or 'month'",
				});
			}

			// Use a stringified key for caching
			const minimal = req.query.minimal === "true";
			const fromFilter = req.query.from as string | undefined; // "YYYY-MM" — only return rows from this month onwards

			const cacheKey = `${table}|${group}|${country}|${region || ""}|${typeFilter || ""}|${statusFilter || ""}|${minimal}|${fromFilter || ""}`;
			const cached = cache.get(cacheKey);
			if (cached) {
				return res.json(cached);
			}

			try {
				// Resolve region codes for filtering
				let resolvedRegion: {
					codes: string[];
					usePrefix: boolean;
					prefix: string | null;
				} | null = null;
				if (region) {
					resolvedRegion = await resolveRegionList(database, region, country);
				}

				const thisYear = new Date().getFullYear();
				const thisMonth = new Date().getMonth() + 1; // 1–12

				let growthData: any[] = [];

				if (group === "year") {
					// Commissioned units
					const addedQuery = database(table)
						.select(
							database.raw(
								"EXTRACT(YEAR FROM commissioning_date)::int as year"
							),
							database.raw("SUM(net_power_kw) as added_power_kw"),
							database.raw("COUNT(*) as added_units")
						)
						.whereNotNull("commissioning_date")
						.andWhere("commissioning_date", "<=", now)
						.andWhere("country", country);

					if (resolvedRegion) {
						applyRegionFilter(addedQuery, resolvedRegion);
					}
					applyOptionalFilters(addedQuery, optionalFilters);

					const addedRaw = await addedQuery
						.groupBy("year")
						.orderBy("year", "asc");

					// Shutdown units
					const removedQuery = database(table)
						.select(
							database.raw(
								"EXTRACT(YEAR FROM shutdown_date)::int as year"
							),
							database.raw("SUM(net_power_kw) as removed_power_kw"),
							database.raw("COUNT(*) as removed_units")
						)
						.whereNotNull("shutdown_date")
						.andWhere("country", country);

					if (resolvedRegion) {
						applyRegionFilter(removedQuery, resolvedRegion);
					}
					applyOptionalFilters(removedQuery, optionalFilters);

					const removedRaw = await removedQuery
						.groupBy("year")
						.orderBy("year", "asc");

					const addedByYear: Record<number, { power: number; units: number }> = {};
					for (const row of addedRaw) {
						const year = parseInt(row.year, 10);
						addedByYear[year] = {
							power: parseFloat(row.added_power_kw) || 0,
							units: parseInt(row.added_units, 10) || 0,
						};
					}

					const removedByYear: Record<number, { power: number; units: number }> = {};
					for (const row of removedRaw) {
						const year = parseInt(row.year, 10);
						removedByYear[year] = {
							power: parseFloat(row.removed_power_kw) || 0,
							units: parseInt(row.removed_units, 10) || 0,
						};
					}

					let cumulativePower = 0;
					let cumulativeUnits = 0;

					// Sum up all added/removed power and units before 2000
					for (const year of Object.keys(addedByYear).map(Number)) {
						if (year < 2000) {
							const added = addedByYear[year]!;
							cumulativePower += added.power;
							cumulativeUnits += added.units;
						}
					}
					for (const year of Object.keys(removedByYear).map(Number)) {
						if (year < 2000) {
							const removed = removedByYear[year]!;
							cumulativePower -= removed.power;
							cumulativeUnits -= removed.units;
						}
					}

					for (let year = 2000; year <= thisYear; year++) {
						const added = addedByYear[year] || { power: 0, units: 0 };
						const removed = removedByYear[year] || { power: 0, units: 0 };

						const netPower = added.power - removed.power;
						const netUnits = added.units - removed.units;

						cumulativePower += netPower;
						cumulativeUnits += netUnits;

						growthData.push({
							year,
							added_power_kw: Math.round(added.power),
							removed_power_kw: Math.round(removed.power),
							net_power_kw: Math.round(netPower),
							cumulative_power_kw: Math.round(cumulativePower),
							added_units: added.units,
							removed_units: removed.units,
							net_units: netUnits,
							cumulative_units: cumulativeUnits,
						});
					}
				} else {
					// group === "month"

					// Commissioned units by year+month
					const addedQuery = database(table)
						.select(
							database.raw(
								"EXTRACT(YEAR FROM commissioning_date)::int as year"
							),
							database.raw(
								"EXTRACT(MONTH FROM commissioning_date)::int as month"
							),
							database.raw("SUM(net_power_kw) as added_power_kw"),
							database.raw("COUNT(*) as added_units")
						)
						.whereNotNull("commissioning_date")
						.andWhere("commissioning_date", "<=", now)
						.andWhere("country", country);

					if (resolvedRegion) {
						applyRegionFilter(addedQuery, resolvedRegion);
					}
					applyOptionalFilters(addedQuery, optionalFilters);

					const addedRaw = await addedQuery
						.groupByRaw("year, month")
						.orderByRaw("year, month");

					// Shutdown units by year+month
					const removedQuery = database(table)
						.select(
							database.raw(
								"EXTRACT(YEAR FROM shutdown_date)::int as year"
							),
							database.raw(
								"EXTRACT(MONTH FROM shutdown_date)::int as month"
							),
							database.raw("SUM(net_power_kw) as removed_power_kw"),
							database.raw("COUNT(*) as removed_units")
						)
						.whereNotNull("shutdown_date")
						.andWhere("country", country);

					if (resolvedRegion) {
						applyRegionFilter(removedQuery, resolvedRegion);
					}
					applyOptionalFilters(removedQuery, optionalFilters);

					const removedRaw = await removedQuery
						.groupByRaw("year, month")
						.orderByRaw("year, month");

					// Use composite key year*100+month for lookups
					const addedByYM: Record<number, { power: number; units: number }> = {};
					for (const row of addedRaw) {
						const key =
							parseInt(row.year, 10) * 100 + parseInt(row.month, 10);
						addedByYM[key] = {
							power: parseFloat(row.added_power_kw) || 0,
							units: parseInt(row.added_units, 10) || 0,
						};
					}

					const removedByYM: Record<number, { power: number; units: number }> = {};
					for (const row of removedRaw) {
						const key =
							parseInt(row.year, 10) * 100 + parseInt(row.month, 10);
						removedByYM[key] = {
							power: parseFloat(row.removed_power_kw) || 0,
							units: parseInt(row.removed_units, 10) || 0,
						};
					}

					let cumulativePower = 0;
					let cumulativeUnits = 0;

					// Accumulate pre-2010 data
					for (const key of Object.keys(addedByYM).map(Number)) {
						if (Math.floor(key / 100) < 2010) {
							cumulativePower += addedByYM[key]!.power;
							cumulativeUnits += addedByYM[key]!.units;
						}
					}
					for (const key of Object.keys(removedByYM).map(Number)) {
						if (Math.floor(key / 100) < 2010) {
							cumulativePower -= removedByYM[key]!.power;
							cumulativeUnits -= removedByYM[key]!.units;
						}
					}

					// Parse optional from filter once: "YYYY-MM" → numeric key y*100+m
					const fromKey = fromFilter
						? parseInt(fromFilter.slice(0, 4), 10) * 100 + parseInt(fromFilter.slice(5, 7), 10)
						: null;

					// Gap-fill from 2010-01 to current year/month
					for (let y = 2010; y <= thisYear; y++) {
						const endMonth = y === thisYear ? thisMonth : 12;
						for (let m = 1; m <= endMonth; m++) {
							const key = y * 100 + m;
							const added = addedByYM[key] || { power: 0, units: 0 };
							const removed = removedByYM[key] || { power: 0, units: 0 };

							const netPower = added.power - removed.power;
							const netUnits = added.units - removed.units;

							cumulativePower += netPower;
							cumulativeUnits += netUnits;

							// Skip rows before the requested from month (cumulative is still computed above)
							if (fromKey !== null && key < fromKey) continue;

							growthData.push({
								year: y,
								month: m,
								date: `${y}-${String(m).padStart(2, "0")}`,
								added_power_kw: Math.round(added.power),
								removed_power_kw: Math.round(removed.power),
								net_power_kw: Math.round(netPower),
								cumulative_power_kw: Math.round(cumulativePower),
								added_units: added.units,
								removed_units: removed.units,
								net_units: netUnits,
								cumulative_units: cumulativeUnits,
							});
						}
					}
				}

				// Type breakdown + grid operator + update date — skipped in minimal mode
				let typesByCategory: Record<
					string,
					{
						power_kw: number;
						units: number;
						added_power_kw_this_year?: number;
						added_units_this_year?: number;
						added_power_kw_this_month?: number;
						added_units_this_month?: number;
					}
				> = {};
				const hasTypeColumn = !minimal && await database.schema.hasColumn(table, "type");

				if (!minimal && hasTypeColumn) {
					// Current totals by type
					const baseQuery = database(table)
						.select("type")
						.whereNotNull("commissioning_date")
						.andWhere("commissioning_date", "<=", now)
						.andWhere("country", country)
						.andWhere((builder) =>
							builder
								.whereNull("shutdown_date")
								.orWhere("shutdown_date", ">", now)
						);

					if (resolvedRegion) {
						applyRegionFilter(baseQuery, resolvedRegion);
					}
					applyOptionalFilters(baseQuery, optionalFilters);

					const typeRows = await baseQuery
						.groupBy("type")
						.select(
							"type",
							database.raw("SUM(net_power_kw)::float as power_kw"),
							database.raw("COUNT(*)::int as units")
						);

					// Period start: first of current month for group=month, first of year for group=year
					const periodStart =
						group === "month"
							? `${thisYear}-${String(thisMonth).padStart(2, "0")}-01`
							: `${thisYear}-01-01`;

					const addedThisPeriodQuery = database(table)
						.select("type")
						.whereNotNull("commissioning_date")
						.andWhere("commissioning_date", ">=", periodStart)
						.andWhere("commissioning_date", "<=", now)
						.andWhere("country", country);

					if (resolvedRegion) {
						applyRegionFilter(addedThisPeriodQuery, resolvedRegion);
					}
					applyOptionalFilters(addedThisPeriodQuery, optionalFilters);

					const addedThisPeriodRows = await addedThisPeriodQuery
						.groupBy("type")
						.select(
							"type",
							database.raw("SUM(net_power_kw)::float as added_power_kw"),
							database.raw("COUNT(*)::int as added_units")
						);

					const periodSuffix =
						group === "month" ? "this_month" : "this_year";

					const addedThisPeriodByType: Record<
						string,
						{ power: number; units: number }
					> = {};
					for (const row of addedThisPeriodRows) {
						const type = row.type || "Unbekannt";
						addedThisPeriodByType[type] = {
							power: row.added_power_kw || 0,
							units: row.added_units || 0,
						};
					}

					for (const row of typeRows) {
						const type = row.type || "Unbekannt";
						const addedThisPeriod = addedThisPeriodByType[type] || {
							power: 0,
							units: 0,
						};
						typesByCategory[type] = {
							power_kw: Math.round(row.power_kw || 0),
							units: row.units || 0,
							[`added_power_kw_${periodSuffix}`]: Math.round(
								addedThisPeriod.power
							),
							[`added_units_${periodSuffix}`]: addedThisPeriod.units,
						};
					}

					// Include types that were only added this period but not in current totals
					for (const type of Object.keys(addedThisPeriodByType)) {
						if (!typesByCategory[type]) {
							const addedThisPeriod = addedThisPeriodByType[type]!;
							typesByCategory[type] = {
								power_kw: 0,
								units: 0,
								[`added_power_kw_${periodSuffix}`]: Math.round(
									addedThisPeriod.power
								),
								[`added_units_${periodSuffix}`]: addedThisPeriod.units,
							};
						}
					}
				}

				// Grid operator review status (only for solar, skipped in minimal mode)
				let gridOperatorCheckedRatio: number | null = null;
				if (!minimal && table === "energy_solar_units") {
					const checkedQuery = database(table)
						.whereNotNull("commissioning_date")
						.andWhere("commissioning_date", "<=", now)
						.andWhere("country", country)
						.andWhere((builder) =>
							builder
								.whereNull("shutdown_date")
								.orWhere("shutdown_date", ">", database.fn.now())
						)
						.andWhere("type", "!=", "2961");

					if (resolvedRegion) {
						applyRegionFilter(checkedQuery, resolvedRegion);
					}
					applyOptionalFilters(checkedQuery, optionalFilters);

					const totalQuery = checkedQuery.clone();
					const checkedOnlyQuery = checkedQuery
						.clone()
						.andWhere("grid_operator_review_status", "Geprüft");

					const [totalCountRow] = await totalQuery.count("* as count");
					const [checkedCountRow] =
						await checkedOnlyQuery.count("* as count");

					const totalCount = parseInt(totalCountRow.count, 10);
					const checkedCount = parseInt(checkedCountRow.count, 10);

					if (totalCount > 0) {
						gridOperatorCheckedRatio = parseFloat(
							((checkedCount / totalCount) * 100).toFixed(2)
						);
					}
				}

				let updateDate = null;
				if (!minimal) {
					const updateDateResult = await database(table)
						.whereNotNull("last_update")
						.orderBy("last_update", "desc")
						.first("last_update");
					updateDate = updateDateResult?.last_update || null;
				}

				const result = {
					[group === "month" ? "by_month" : "by_year"]: growthData,
					current_by_type: hasTypeColumn ? typesByCategory : null,
					grid_operator_checked_ratio: gridOperatorCheckedRatio,
					update_date: updateDate,
				};

				cache.set(cacheKey, result);
				res.json(result);
			} catch (err: any) {
				res.status(500).json({
					error: "Failed to calculate power stats",
					details: err.message,
				});
			}
		});
	},
};
