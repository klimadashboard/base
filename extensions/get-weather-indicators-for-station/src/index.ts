import { Router, Request, Response } from "express";

export default {
	id: "get-weather-indicators-for-station",
	handler: (router: Router, { database }) => {
		router.get("/", async (req: Request, res: Response) => {
			const station = req.query.station as string;
			const table = req.query.table as string;

			if (!station || !["de_dwd_data", "at_geosphere_data"].includes(table)) {
				return res
					.status(400)
					.json({ error: "Missing or invalid station/table" });
			}

			try {
				const rows = await database(table)
					.select(["date", "tlmax", "tlmin"])
					.where("station", station);

				const indicators: Record<string, any> = {};

				const now = new Date();
				const currentYear = now.getFullYear();
				const lastYear = currentYear - 1;

				const buckets = {
					[currentYear]: [] as any[],
					[lastYear]: [] as any[],
					historic: [] as any[],
				};

				for (const row of rows) {
					const date = new Date(row.date);
					const year = date.getFullYear();
					if (year === currentYear) buckets[currentYear].push(row);
					else if (year === lastYear) buckets[lastYear].push(row);
					else if (year >= 1961 && year <= 1990) buckets.historic.push(row);
				}

				const definitions: Record<string, (d: any) => boolean> = {
					summerDay: (d) => d.tlmax >= 25,
					heatDay: (d) => d.tlmax >= 30,
					extremeHeatDay: (d) => d.tlmax >= 35,
					tropicalNight: (d) => d.tlmin >= 20,
					frostDay: (d) => d.tlmin < 0,
					snowCoverDay: (d) => d.sh >= 1,
					iceDay: (d) => d.tlmax < 0,
				};

				const calc = (bucket: any[]) => {
					const out: Record<string, any> = {};
					for (const [key, fn] of Object.entries(definitions)) {
						out[key] = matchDays(bucket, fn);
					}
					return out;
				};

				const thisY = calc(buckets[currentYear]);
				const lastY = calc(buckets[lastYear]);
				const hist = calc(buckets.historic);

				for (const key of Object.keys(definitions)) {
					indicators[key] = {
						thisYear: thisY[key]?.count ?? 0,
						lastYear: lastY[key]?.count ?? 0,
						historicAverage1961to1990:
							hist[key]?.count > 0 ? Math.round(hist[key].count / 30) : 0,
						mostRecentOccurrence:
							thisY[key]?.latestDaysAgo ?? lastY[key]?.latestDaysAgo ?? null,
					};
				}

				res.json(indicators);
			} catch (err: any) {
				res
					.status(500)
					.json({ error: "Failed to fetch indicators", details: err.message });
			}
		});
	},
};

function matchDays(data: any[], predicate: (row: any) => boolean) {
	const now = new Date();
	const matched = data.filter(predicate);

	const latestDate = matched
		.map((d) => new Date(d.date))
		.sort((a, b) => b.getTime() - a.getTime())[0];

	const latestDaysAgo = latestDate
		? Math.floor((now.getTime() - latestDate.getTime()) / (1000 * 60 * 60 * 24))
		: null;

	return {
		count: matched.length,
		latestDaysAgo,
	};
}
