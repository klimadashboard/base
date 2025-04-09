import { Router, Request, Response } from "express";

export default {
	id: "get-nearest-stations",
	handler: (router: Router, { database }) => {
		router.get("/", async (req: Request, res: Response) => {
			const lat = parseFloat(req.query.lat as string);
			const lon = parseFloat(req.query.lon as string);
			const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);

			if (isNaN(lat) || isNaN(lon)) {
				return res.status(400).json({ error: "Invalid coordinates" });
			}

			const haversineSql = `
				6371 * acos(
					cos(radians(:lat)) * cos(radians(latitude)) *
					cos(radians(longitude) - radians(:lon)) +
					sin(radians(:lat)) * sin(radians(latitude))
				)
			`;

			try {
				const atStations = await database
					.select(
						"*",
						database.raw(`${haversineSql} AS distance_km`, { lat, lon })
					)
					.from("at_geosphere_stations")
					.orderBy("distance_km")
					.limit(limit);

				const deStations = await database
					.select(
						"*",
						database.raw(`${haversineSql} AS distance_km`, { lat, lon })
					)
					.from("de_dwd_stations")
					.orderBy("distance_km")
					.limit(limit);

				const stations = [
					...atStations.map((s: any) => ({
						...s,
						source: "at_geosphere_stations",
					})),
					...deStations.map((s: any) => ({ ...s, source: "de_dwd_stations" })),
				]
					.sort((a, b) => a.distance_km - b.distance_km)
					.slice(0, limit);

				res.json(stations);
			} catch (err: any) {
				res
					.status(500)
					.json({ error: "Internal Server Error", details: err.message });
			}
		});
	},
};
