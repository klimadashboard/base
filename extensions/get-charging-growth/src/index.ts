import { Router, Request, Response } from "express";
import { LRUCache } from "lru-cache";

const TABLE = "mobility_charging_stations";
const SOURCE = "Bundesnetzagentur, Ladesäulenregister (CC BY 4.0)";

// LRU cache: up to 500 entries, 6-hour TTL (data changes about monthly)
const cache = new LRUCache<string, any>({
	max: 500,
	ttl: 1000 * 60 * 60 * 6,
});

type Filter = { prefixes: string[]; codes: string[] };

type Stock = {
	charging_points_normal: number;
	charging_points_fast: number;
	power_kw_normal: number;
	power_kw_fast: number;
	stations: number;
};

function isUUID(str: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		str
	);
}

// ────────────────────────────────────────────────
// Region resolution
// region accepts one or more (comma-separated) regions ids, codes or AGS
// prefixes. state / district → prefix on region_code (2 / 5 digits),
// municipality → exact 8-digit AGS. Several regions are summed, e.g. the
// 34 districts of the Metropolregion Nürnberg.
// ────────────────────────────────────────────────
async function resolveRegions(
	database: any,
	regionInput: string
): Promise<{ filter: Filter; regions: any[] }> {
	const inputs = regionInput
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const filter: Filter = { prefixes: [], codes: [] };
	const regions: any[] = [];

	for (const input of inputs) {
		const row = await database("regions")
			.select("id", "name", "code", "code_short", "layer", "population")
			.where((qb: any) => {
				if (isUUID(input)) qb.where("id", input);
				else qb.where("code_short", input).orWhere("code", input);
			})
			.andWhere("country", "DE")
			.first();

		if (!row) {
			// Unknown code: treat short codes as AGS prefixes, long ones as exact
			if (/^\d{1,7}$/.test(input)) filter.prefixes.push(input);
			else filter.codes.push(input);
			continue;
		}

		regions.push(row);
		if (row.layer === "country") {
			filter.prefixes.push("");
		} else if (row.layer === "state" || row.layer === "district") {
			filter.prefixes.push(String(row.code_short || row.code));
		} else {
			filter.codes.push(String(row.code_short || row.code).slice(0, 8));
		}
	}

	return { filter, regions };
}

function applyRegionFilter(query: any, filter: Filter | null): void {
	if (!filter || filter.prefixes.includes("")) return;
	query.andWhere((qb: any) => {
		for (const prefix of filter.prefixes) {
			qb.orWhere("region_code", "like", `${prefix}%`);
		}
		if (filter.codes.length) qb.orWhereIn("region_code", filter.codes);
	});
}

function emptyStock(): Stock {
	return {
		charging_points_normal: 0,
		charging_points_fast: 0,
		power_kw_normal: 0,
		power_kw_fast: 0,
		stations: 0,
	};
}

function withTotals(stock: Stock) {
	return {
		...stock,
		charging_points: stock.charging_points_normal + stock.charging_points_fast,
		power_kw: Math.round(stock.power_kw_normal + stock.power_kw_fast),
		power_kw_normal: Math.round(stock.power_kw_normal),
		power_kw_fast: Math.round(stock.power_kw_fast),
	};
}

function addRow(stock: Stock, row: any, sign: 1 | -1): void {
	const points = (parseInt(row.charging_points, 10) || 0) * sign;
	const power = (parseFloat(row.power_kw) || 0) * sign;
	if (row.type === "fast") {
		stock.charging_points_fast += points;
		stock.power_kw_fast += power;
	} else {
		stock.charging_points_normal += points;
		stock.power_kw_normal += power;
	}
	stock.stations += (parseInt(row.stations, 10) || 0) * sign;
}

// ────────────────────────────────────────────────
// Region context for normalisation (per 1000 inhabitants / per 1000 EVs)
// Electric cars come from mobility_cars (category "Elektro", yearly per
// district), so they are only available for district level and above.
// ────────────────────────────────────────────────
async function regionContext(database: any, regions: any[], filter: Filter | null) {
	let population: number | null = null;
	if (regions.length) {
		population = regions.reduce((sum, r) => sum + (parseInt(r.population, 10) || 0), 0);
	} else if (!filter) {
		const de = await database("regions").where({ layer: "country", country: "DE" }).first("population");
		population = de?.population ?? null;
	}

	if (filter && filter.codes.length) {
		return { population, electric_cars: null };
	}

	const latest = await database("mobility_cars")
		.where({ category: "Elektro", country: "DE" })
		.whereRaw("LENGTH(period) = 4")
		.max("period as period")
		.first();
	if (!latest?.period) return { population, electric_cars: null };

	const evQuery = database("mobility_cars")
		.where({ category: "Elektro", country: "DE", period: latest.period })
		.whereRaw("LENGTH(region) = 5");
	if (filter && !filter.prefixes.includes("")) {
		evQuery.andWhere((qb: any) => {
			for (const prefix of filter.prefixes) qb.orWhere("region", "like", `${prefix}%`);
		});
	}
	const ev = await evQuery.sum("value as value").select(database.raw("MIN(source) as source")).first();

	return {
		population,
		electric_cars: ev?.value
			? { period: latest.period, value: parseInt(ev.value, 10), source: ev.source }
			: null,
	};
}

// ────────────────────────────────────────────────
// group=year | group=month → stock at the end of every period
// ────────────────────────────────────────────────
async function handleTimeSeries(
	database: any,
	group: "year" | "month",
	filter: Filter | null
) {
	const periodExpr = (col: string) =>
		group === "year"
			? `EXTRACT(YEAR FROM ${col})::int::text`
			: `TO_CHAR(${col}, 'YYYY-MM')`;

	const aggregate = (col: string) => {
		const query = database(TABLE)
			.select(
				database.raw(`${periodExpr(col)} as period`),
				"type",
				database.raw("SUM(charging_points) as charging_points"),
				database.raw("SUM(power_kw) as power_kw"),
				database.raw("COUNT(*) as stations")
			)
			.whereNotNull(col);
		applyRegionFilter(query, filter);
		return query.groupBy("period", "type");
	};

	const [added, removed] = await Promise.all([
		aggregate("commissioning_date"),
		aggregate("shutdown_date"),
	]);

	const deltas = new Map<string, { added: Stock; removed: Stock }>();
	const delta = (period: string) => {
		if (!deltas.has(period)) deltas.set(period, { added: emptyStock(), removed: emptyStock() });
		return deltas.get(period)!;
	};
	for (const row of added) addRow(delta(String(row.period)).added, row, 1);
	for (const row of removed) addRow(delta(String(row.period)).removed, row, 1);

	if (deltas.size === 0) return [];

	// Gap-filled periods from the first commissioning until now
	const first = Array.from(deltas.keys()).sort()[0]!;
	const now = new Date();
	const periods: string[] = [];
	if (group === "year") {
		for (let y = parseInt(first, 10); y <= now.getFullYear(); y++) periods.push(String(y));
	} else {
		let [y, m] = first.split("-").map(Number) as [number, number];
		while (y < now.getFullYear() || (y === now.getFullYear() && m <= now.getMonth() + 1)) {
			periods.push(`${y}-${String(m).padStart(2, "0")}`);
			m++;
			if (m > 12) { m = 1; y++; }
		}
	}

	const stock = emptyStock();
	return periods.map((period) => {
		const d = deltas.get(period);
		if (d) {
			for (const key of Object.keys(stock) as (keyof Stock)[]) {
				stock[key] += d.added[key] - d.removed[key];
			}
		}
		const addedHere = d?.added ?? emptyStock();
		return {
			period,
			...withTotals(stock),
			added_charging_points: addedHere.charging_points_normal + addedHere.charging_points_fast,
			added_power_kw: Math.round(addedHere.power_kw_normal + addedHere.power_kw_fast),
		};
	});
}

// ────────────────────────────────────────────────
// group=state | district | municipality → stock per region at ?date
// ────────────────────────────────────────────────
async function handleRegionSnapshot(
	database: any,
	groupBy: "state" | "district" | "municipality",
	date: string,
	filter: Filter | null
) {
	const len = { state: 2, district: 5, municipality: 8 }[groupBy];
	const query = database(TABLE)
		.select(
			database.raw(`LEFT(region_code, ${len}) as group_code`),
			"type",
			database.raw("SUM(charging_points) as charging_points"),
			database.raw("SUM(power_kw) as power_kw"),
			database.raw("COUNT(*) as stations")
		)
		.whereNotNull("region_code")
		.andWhere("commissioning_date", "<=", date)
		.andWhere((qb: any) => qb.whereNull("shutdown_date").orWhere("shutdown_date", ">", date));
	applyRegionFilter(query, filter);
	const rows = await query.groupBy("group_code", "type");

	const stocks = new Map<string, Stock>();
	for (const row of rows) {
		if (!stocks.has(row.group_code)) stocks.set(row.group_code, emptyStock());
		addRow(stocks.get(row.group_code)!, row, 1);
	}

	const codes = Array.from(stocks.keys());
	const regionRows = codes.length
		? await database("regions")
				.select("id", "name", "code", "code_short", "population")
				.where({ country: "DE", layer: groupBy })
				.andWhere((qb: any) =>
					groupBy === "municipality"
						? qb.whereIn("code_short", codes)
						: qb.whereIn("code", codes)
				)
		: [];
	const byCode = new Map<string, any>(
		regionRows.map((r: any) => [groupBy === "municipality" ? r.code_short : r.code, r])
	);

	return codes.sort().map((code) => {
		const region = byCode.get(code);
		return {
			region_code: code,
			region: region?.id ?? null,
			name: region?.name ?? null,
			population: region?.population ?? null,
			...withTotals(stocks.get(code)!),
		};
	});
}

export default {
	id: "get-charging-growth",
	handler: (router: Router, { database }: { database: any }) => {
		router.get("/", async (req: Request, res: Response) => {
			const group = req.query.group as string;
			const region = req.query.region as string | undefined;
			const date = (req.query.date as string) || new Date().toISOString().slice(0, 10);

			const validGroups = ["year", "month", "state", "district", "municipality"];
			if (!group || !validGroups.includes(group)) {
				return res.status(400).json({
					error: `Invalid group. Use ?group=${validGroups.join("|")}`,
				});
			}
			if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
				return res.status(400).json({ error: "Invalid date. Use ?date=YYYY-MM-DD" });
			}

			const cacheKey = `charging|${group}|${region || "all"}|${group === "year" || group === "month" ? "" : date}`;
			const cached = req.query.refresh === "true" ? undefined : cache.get(cacheKey);
			res.setHeader("Cache-Control", "public, max-age=3600");
			if (cached) return res.json(cached);

			try {
				const resolved = region ? await resolveRegions(database, region) : null;
				const filter = resolved?.filter ?? null;

				const updateDate = await database(TABLE)
					.select(database.raw("TO_CHAR(MAX(last_seen), 'YYYY-MM-DD') as last_seen"))
					.first();
				const meta = {
					update_date: updateDate?.last_seen || null,
					source: SOURCE,
				};

				let result: any;
				if (group === "year" || group === "month") {
					const [byPeriod, context] = await Promise.all([
						handleTimeSeries(database, group, filter),
						regionContext(database, resolved?.regions ?? [], filter),
					]);
					result = {
						regions: (resolved?.regions ?? []).map((r) => ({ id: r.id, name: r.name, layer: r.layer })),
						...context,
						by_period: byPeriod,
						...meta,
					};
				} else {
					result = {
						date,
						regions: await handleRegionSnapshot(
							database,
							group as "state" | "district" | "municipality",
							date,
							filter
						),
						...meta,
					};
				}

				cache.set(cacheKey, result);
				return res.json(result);
			} catch (err: any) {
				return res.status(500).json({
					error: "Failed to calculate charging stats",
					details: err.message,
				});
			}
		});
	},
};
