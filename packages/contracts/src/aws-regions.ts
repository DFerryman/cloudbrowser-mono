/**
 * What AWS APIs do not say about a region: where its data centers are. The city and timezone
 * describe the browser's location and IP; the coordinates estimate network latency before the
 * user's own measurement arrives; the area groups a long region list. Regions missing here
 * still work, with the provider's name and no estimate.
 */
export const REGION_AREAS = ['asia_pacific', 'europe', 'north_america', 'south_america', 'middle_east', 'africa'] as const;
export type RegionArea = (typeof REGION_AREAS)[number];

export interface AwsRegionFacts {
  city: string;
  /** ISO 3166 country of the region's addresses, as IP geolocation reports them. */
  country: string;
  timezone: string;
  area: RegionArea;
  lat: number;
  lon: number;
}

export const AWS_REGION_FACTS: Record<string, AwsRegionFacts> = {
  'us-east-1': { city: 'N. Virginia', country: 'US', timezone: 'America/New_York', area: 'north_america', lat: 38.9, lon: -77.4 },
  'us-east-2': { city: 'Ohio', country: 'US', timezone: 'America/New_York', area: 'north_america', lat: 40.0, lon: -83.0 },
  'us-west-1': { city: 'N. California', country: 'US', timezone: 'America/Los_Angeles', area: 'north_america', lat: 37.4, lon: -121.9 },
  'us-west-2': { city: 'Oregon', country: 'US', timezone: 'America/Los_Angeles', area: 'north_america', lat: 45.8, lon: -119.7 },
  'ca-central-1': { city: 'Montreal', country: 'CA', timezone: 'America/Toronto', area: 'north_america', lat: 45.5, lon: -73.6 },
  'ca-west-1': { city: 'Calgary', country: 'CA', timezone: 'America/Edmonton', area: 'north_america', lat: 51.0, lon: -114.1 },
  'mx-central-1': { city: 'Querétaro', country: 'MX', timezone: 'America/Mexico_City', area: 'north_america', lat: 20.6, lon: -100.4 },
  'sa-east-1': { city: 'São Paulo', country: 'BR', timezone: 'America/Sao_Paulo', area: 'south_america', lat: -23.5, lon: -46.6 },
  'eu-west-1': { city: 'Dublin', country: 'IE', timezone: 'Europe/Dublin', area: 'europe', lat: 53.3, lon: -6.3 },
  'eu-west-2': { city: 'London', country: 'GB', timezone: 'Europe/London', area: 'europe', lat: 51.5, lon: -0.1 },
  'eu-west-3': { city: 'Paris', country: 'FR', timezone: 'Europe/Paris', area: 'europe', lat: 48.9, lon: 2.4 },
  'eu-central-1': { city: 'Frankfurt', country: 'DE', timezone: 'Europe/Berlin', area: 'europe', lat: 50.1, lon: 8.7 },
  'eu-central-2': { city: 'Zurich', country: 'CH', timezone: 'Europe/Zurich', area: 'europe', lat: 47.4, lon: 8.5 },
  'eu-north-1': { city: 'Stockholm', country: 'SE', timezone: 'Europe/Stockholm', area: 'europe', lat: 59.3, lon: 18.1 },
  'eu-south-1': { city: 'Milan', country: 'IT', timezone: 'Europe/Rome', area: 'europe', lat: 45.5, lon: 9.2 },
  'eu-south-2': { city: 'Aragón', country: 'ES', timezone: 'Europe/Madrid', area: 'europe', lat: 41.6, lon: -0.9 },
  'il-central-1': { city: 'Tel Aviv', country: 'IL', timezone: 'Asia/Jerusalem', area: 'middle_east', lat: 32.1, lon: 34.8 },
  'me-central-1': { city: 'UAE', country: 'AE', timezone: 'Asia/Dubai', area: 'middle_east', lat: 25.2, lon: 55.3 },
  'me-south-1': { city: 'Bahrain', country: 'BH', timezone: 'Asia/Bahrain', area: 'middle_east', lat: 26.1, lon: 50.6 },
  'af-south-1': { city: 'Cape Town', country: 'ZA', timezone: 'Africa/Johannesburg', area: 'africa', lat: -33.9, lon: 18.4 },
  'ap-east-1': { city: 'Hong Kong', country: 'HK', timezone: 'Asia/Hong_Kong', area: 'asia_pacific', lat: 22.3, lon: 114.2 },
  'ap-east-2': { city: 'Taipei', country: 'TW', timezone: 'Asia/Taipei', area: 'asia_pacific', lat: 25.0, lon: 121.5 },
  'ap-south-1': { city: 'Mumbai', country: 'IN', timezone: 'Asia/Kolkata', area: 'asia_pacific', lat: 19.1, lon: 72.9 },
  'ap-south-2': { city: 'Hyderabad', country: 'IN', timezone: 'Asia/Kolkata', area: 'asia_pacific', lat: 17.4, lon: 78.5 },
  'ap-northeast-1': { city: 'Tokyo', country: 'JP', timezone: 'Asia/Tokyo', area: 'asia_pacific', lat: 35.7, lon: 139.7 },
  'ap-northeast-2': { city: 'Seoul', country: 'KR', timezone: 'Asia/Seoul', area: 'asia_pacific', lat: 37.6, lon: 127.0 },
  'ap-northeast-3': { city: 'Osaka', country: 'JP', timezone: 'Asia/Tokyo', area: 'asia_pacific', lat: 34.7, lon: 135.5 },
  'ap-southeast-1': { city: 'Singapore', country: 'SG', timezone: 'Asia/Singapore', area: 'asia_pacific', lat: 1.35, lon: 103.8 },
  'ap-southeast-2': { city: 'Sydney', country: 'AU', timezone: 'Australia/Sydney', area: 'asia_pacific', lat: -33.9, lon: 151.2 },
  'ap-southeast-3': { city: 'Jakarta', country: 'ID', timezone: 'Asia/Jakarta', area: 'asia_pacific', lat: -6.2, lon: 106.8 },
  'ap-southeast-4': { city: 'Melbourne', country: 'AU', timezone: 'Australia/Melbourne', area: 'asia_pacific', lat: -37.8, lon: 145.0 },
  'ap-southeast-5': { city: 'Kuala Lumpur', country: 'MY', timezone: 'Asia/Kuala_Lumpur', area: 'asia_pacific', lat: 3.1, lon: 101.7 },
  'ap-southeast-6': { city: 'Auckland', country: 'NZ', timezone: 'Pacific/Auckland', area: 'asia_pacific', lat: -36.8, lon: 174.8 },
  'ap-southeast-7': { city: 'Bangkok', country: 'TH', timezone: 'Asia/Bangkok', area: 'asia_pacific', lat: 13.8, lon: 100.5 },
};

/**
 * A regional AWS endpoint that answers `GET /ping` without credentials. The browser times a few
 * no-cors requests to it to measure latency from the user's own network (CSP: connect-src).
 */
export function awsLatencyProbeUrl(providerRegion: string): string | null {
  return AWS_REGION_FACTS[providerRegion] ? `https://dynamodb.${providerRegion}.amazonaws.com/ping` : null;
}

/**
 * Round-trip estimate from great-circle distance: light in fiber travels about 200 km per ms, so
 * every 100 km of distance adds about 1 ms of round trip; real routes run roughly 1.5 times the
 * straight line, plus a few ms of access network. Only a hint until the browser measures.
 */
export function estimateRttMs(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const rad = Math.PI / 180;
  const dLat = (to.lat - from.lat) * rad;
  const dLon = (to.lon - from.lon) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(from.lat * rad) * Math.cos(to.lat * rad) * Math.sin(dLon / 2) ** 2;
  const km = 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
  return Math.round(5 + (2 * km * 1.5) / 200);
}
