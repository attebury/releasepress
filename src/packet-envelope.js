import { validatePacketEnvelope } from "attepack";
import { ReleasepressError } from "./config.js";

export const RELEASEPRESS_PACKET_SCHEMA_VERSION = 1;

export function releasepressEnvelope({ ok, type, schemaVersion = RELEASEPRESS_PACKET_SCHEMA_VERSION }) {
  const envelope = {
    ok,
    type,
    schema_version: schemaVersion
  };
  validateReleasepressPacketEnvelope(envelope, {
    expectedType: type,
    expectedSchemaVersion: schemaVersion
  });
  return envelope;
}

export function validateReleasepressPacketEnvelope(
  packet,
  {
    expectedType,
    expectedSchemaVersion = RELEASEPRESS_PACKET_SCHEMA_VERSION,
    errorCode = "packet_envelope_invalid",
    errorMessage = "Releasepress packet envelope is invalid"
  } = {}
) {
  try {
    validatePacketEnvelope(packet, {
      expectedType,
      expectedSchemaVersion
    });
  } catch (error) {
    throw new ReleasepressError(errorCode, errorMessage, {
      expected_type: expectedType ?? null,
      expected_schema_version: expectedSchemaVersion,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
  return packet;
}
