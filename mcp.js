import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import * as D from './db.js';

const date = z.string().describe('Date as YYYY-MM-DD. Resolve relative dates ("next Friday") yourself using the server_today value from list_properties.');

function build(ws, baseUrl) {
  const s = new McpServer({ name: 'staydesk', version: '1.0.0' });
  const link = (b) => ({ ...b, guest_link: `${baseUrl}/q/${b.token}`, token: undefined });
  const ok = (d) => ({ content: [{ type: 'text', text: typeof d === 'string' ? d : JSON.stringify(d, null, 2) }] });
  const run = (fn) => async (args) => {
    try { return ok(await fn(args || {})); } catch (e) { return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] }; }
  };
  const RO = { readOnlyHint: true };

  s.registerTool('list_properties', {
    title: 'List properties and units',
    description: 'Start here. Returns every property with its units (rooms/villas): unit_id, capacity, nightly price, weekend price, plus server_today. Use unit_id values in other tools.',
    annotations: RO,
  }, run(() => ({ server_today: D.today(), currency: 'INR', properties: D.listProperties(ws.id) })));

  s.registerTool('add_property', {
    title: 'Add a property',
    description: 'Create a property with one or more units (rooms or villas). It appears instantly on the host\'s dashboard, where they can edit prices and capacity.',
    inputSchema: {
      name: z.string(), location: z.string().describe('Town or region, e.g. Coorg'),
      description: z.string().optional().describe('One or two lines a guest would care about'),
      units: z.array(z.object({
        name: z.string(), capacity: z.number().int().positive(),
        price_per_night: z.number().positive().describe('INR, weekday night'),
        weekend_price: z.number().positive().optional().describe('INR, Friday and Saturday nights'),
      })).min(1),
    },
  }, run((a) => D.addProperty(ws.id, { ...a, units: a.units.map((u) => ({ ...u, price: u.price_per_night })) })));

  s.registerTool('check_availability', {
    title: 'Check availability and price',
    description: 'Find units that are free for the dates and can sleep the party, with the total price for the stay. Active holds and confirmed bookings block dates. Optionally filter by location or property name.',
    inputSchema: { check_in: date, check_out: date.describe('Check-out date (the night before is the last night)'), guests: z.number().int().positive(), location: z.string().optional() },
    annotations: RO,
  }, run((a) => D.availability(ws.id, a.check_in, a.check_out, a.guests, a.location)));

  s.registerTool('hold_dates', {
    title: 'Hold dates for a guest',
    description: 'Tentatively block a unit for a guest and create a shareable guest link. YOU write quote_message: a warm, ready-to-send WhatsApp message with the property, dates, number of guests, total in rupees, what is included, when the hold expires and how to confirm. The app stores it, shows it to the guest at the link, and lets the human host edit it. After this succeeds, show the user the guest_link and the message. Call check_availability first.',
    inputSchema: {
      unit_id: z.number().int(), check_in: date, check_out: date, guests: z.number().int().positive(),
      guest_name: z.string(), guest_phone: z.string().optional().describe('With country code, e.g. 919876543210'),
      quote_message: z.string().describe('The full message to send the guest'),
      hold_hours: z.number().int().min(1).max(168).optional().describe('Default 24'), notes: z.string().optional().describe('Internal notes for the host'),
    },
  }, run((a) => link(D.createBooking(ws.id, { ...a, status: 'hold', source: 'claude' }))));

  s.registerTool('confirm_booking', {
    title: 'Confirm a booking',
    description: 'Convert a hold into a confirmed booking once the guest has agreed or paid. Fails if the hold expired and the dates were taken.',
    inputSchema: { booking_id: z.number().int() },
  }, run((a) => link(D.setStatus(ws.id, a.booking_id, 'confirmed'))));

  s.registerTool('cancel_booking', {
    title: 'Cancel a booking or hold',
    description: 'Cancel a hold or booking and free the dates.',
    inputSchema: { booking_id: z.number().int() },
    annotations: { destructiveHint: true },
  }, run((a) => link(D.setStatus(ws.id, a.booking_id, 'cancelled'))));

  s.registerTool('list_bookings', {
    title: 'List bookings',
    description: 'List bookings and holds, newest first. Status is one of hold, confirmed, cancelled, expired.',
    inputSchema: { status: z.enum(['hold', 'confirmed', 'cancelled', 'expired']).optional(), from: date.optional(), to: date.optional() },
    annotations: RO,
  }, run((a) => D.listBookings(ws.id)
    .filter((b) => (!a.status || b.status === a.status) && (!a.from || b.check_out > a.from) && (!a.to || b.check_in < a.to))
    .slice(0, 50).map(link)));

  s.registerTool('sales_summary', {
    title: 'Monthly sales summary',
    description: 'Confirmed revenue, occupancy, open holds and a per-property breakdown for a month. Use it to write the host a short report.',
    inputSchema: { month: z.string().optional().describe('YYYY-MM, defaults to the current month') },
    annotations: RO,
  }, run((a) => D.summary(ws.id, a.month)));

  return s;
}

export async function mcpHandler(req, res) {
  const ws = D.wsByKey(req.params.key);
  if (!ws) return res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unknown StayDesk workspace link.' }, id: null });
  const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const server = build(ws, baseUrl);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}
