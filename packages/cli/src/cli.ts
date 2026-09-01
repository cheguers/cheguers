import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { subcommands } from "./commands.js";

const cheguers = Command.make("cheguers").pipe(
  Command.withDescription("Thin CLI over CheguersDB core"),
  Command.withSubcommands([...subcommands]),
);

cheguers.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
