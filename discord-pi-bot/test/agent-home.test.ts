import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEntity, type HassEntity } from "../src/harness/entities.ts";
import {
	fastPathEligible,
	parseAmount,
	planCommand,
	readIntentReply,
	stateText,
} from "../src/agent/home.ts";

const entity = (entity_id: string, state: string, attributes: Record<string, unknown> = {}) =>
	normalizeEntity({ entity_id, state, attributes: { friendly_name: entity_id, ...attributes } } as HassEntity);

const lamp = entity("light.desk", "on", { supported_color_modes: ["color_temp", "hs"], brightness: 128, color_temp_kelvin: 4000 });

test("brightness is given in percent and sent in Home Assistant's 0–255", () => {
	const plan = planCommand(lamp, "set_brightness", "40%");
	assert.equal(plan.service, "turn_on");
	assert.equal(plan.serviceData.brightness, 102);
	assert.equal(plan.requiresConfirmation, false);
});

test("relative brightness works from the current level, and 0% turns the light off", () => {
	assert.equal(planCommand(lamp, "set_brightness", "+20").serviceData.brightness, 179);
	assert.equal(planCommand(lamp, "set_brightness", "0").service, "turn_off");
});

test("colour words become RGB, and warmth words become kelvin", () => {
	assert.deepEqual(planCommand(lamp, "set_color", "red").serviceData.rgb_color, [255, 0, 0]);
	assert.equal(planCommand(lamp, "set_color_temperature", "warm").serviceData.color_temp_kelvin, 2700);
	assert.equal(planCommand(lamp, "set_color_temperature", "warmer").serviceData.color_temp_kelvin, 3300);
	assert.throws(() => planCommand(lamp, "set_color", "sparkly"));
});

test("lights, switches, media and climate run directly", () => {
	assert.equal(planCommand(lamp, "turn_off").requiresConfirmation, false);
	assert.equal(planCommand(entity("switch.kettle", "off"), "turn_on").requiresConfirmation, false);
	assert.equal(planCommand(entity("media_player.tv", "playing"), "pause").service, "media_pause");
	assert.equal(planCommand(entity("media_player.tv", "playing"), "pause").requiresConfirmation, false);
	const thermostat = entity("climate.hall", "heat", { temperature: 20, min_temp: 5, max_temp: 30 });
	const plan = planCommand(thermostat, "set_temperature", "+1");
	assert.equal(plan.serviceData.temperature, 21);
	assert.equal(plan.requiresConfirmation, false);
});

test("locks, covers, valves and anything unusual wait for a tap", () => {
	const door = entity("lock.front", "locked");
	assert.equal(planCommand(door, "unlock").requiresConfirmation, true);
	assert.equal(planCommand(door, "unlock").destructive, true);
	assert.equal(planCommand(door, "lock").requiresConfirmation, true);
	const garage = entity("cover.garage", "closed");
	assert.equal(planCommand(garage, "open").service, "open_cover");
	assert.equal(planCommand(garage, "open").requiresConfirmation, true);
	assert.equal(planCommand(entity("vacuum.robo", "docked"), "start").requiresConfirmation, true);
	assert.equal(planCommand(entity("script.bedtime", "off"), "turn_on").requiresConfirmation, true);
});

test("a command a device cannot do is refused, not guessed", () => {
	assert.throws(() => planCommand(entity("lock.front", "locked"), "turn_on"), /lock or unlock/);
	assert.throws(() => planCommand(entity("switch.kettle", "off"), "set_brightness", "50"));
	assert.throws(() => planCommand(entity("sensor.temp", "20"), "play"));
	assert.throws(() => planCommand(entity("light.gone", "unavailable"), "turn_on"));
});

test("amounts parse with units, signs and words", () => {
	assert.deepEqual(parseAmount("30%"), { amount: 30, relative: false });
	assert.deepEqual(parseAmount("-10"), { amount: -10, relative: true });
	assert.deepEqual(parseAmount("21,5°"), { amount: 21.5, relative: false });
	assert.deepEqual(parseAmount("half"), { amount: 50, relative: false });
	assert.equal(parseAmount("bright"), undefined);
});

test("risky wording never takes the no-confirmation fast path", () => {
	assert.equal(fastPathEligible("turn off the kitchen light"), true);
	assert.equal(fastPathEligible("what is the temperature in the office"), true);
	for (const prompt of ["unlock the front door", "open the garage", "close the blinds", "disarm the alarm"])
		assert.equal(fastPathEligible(prompt), false, prompt);
});

test("Home Assistant's reply is used only when it actually handled the request", () => {
	assert.equal(
		readIntentReply({ response: { response_type: "error", data: { code: "no_intent_match" } } }),
		undefined,
	);
	const handled = readIntentReply({
		response: {
			response_type: "action_done",
			speech: { plain: { speech: "Turned off the light" } },
			data: {
				success: [
					{ id: "kitchen", name: "Kitchen", type: "area" },
					{ id: "light.kitchen", name: "Kitchen Light", type: "entity" },
				],
			},
		},
	});
	assert.deepEqual(handled, { speech: "Turned off the light", entityIds: ["light.kitchen"], kind: "action_done" });
});

test("states read as words a person would say", () => {
	assert.equal(stateText(lamp), "on at 50%");
	assert.equal(stateText(entity("binary_sensor.window", "on", { device_class: "window" })), "open");
	assert.equal(stateText(entity("sensor.temp", "20.5", { unit_of_measurement: "°C" })), "20.5 °C");
});
