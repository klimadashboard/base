import { Router, Request, Response } from "express";

export default {
	id: "get-nearby-stops",
	handler: (router: Router, { database }) => {
		router.get("/", async (req: Request, res: Response) => {
			const lat = parseFloat(req.query.lat as string);
			const lon = parseFloat(req.query.lon as string);
			const radiusKm = parseFloat((req.query.radius_km as string) || "10");

			if (isNaN(lat) || isNaN(lon)) {
				return res.status(400).json({
					error: "Invalid or missing lat/lon parameters",
				});
			}

			try {
				const stops = await database("mobility_stops")
					.select("*")
					.whereNotNull("center")
					.andWhereRaw(
						`6371 * 2 * ASIN(SQRT(
							POWER(SIN(RADIANS(? - (center->>1)::float) / 2), 2) +
							COS(RADIANS(?)) * COS(RADIANS((center->>1)::float)) *
							POWER(SIN(RADIANS(? - (center->>0)::float) / 2), 2)
						)) < ?`,
						[lat, lat, lon, radiusKm]
					);

				res.json(stops);
			} catch (err: any) {
				res.status(500).json({
					error: "Failed to fetch nearby stops",
					details: err.message,
				});
			}
		});
	},
};
