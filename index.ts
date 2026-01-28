import { type Plugin, tool } from "@opencode-ai/plugin"

export const CustomToolPlugin: Plugin = async () => {
  return {
    tool: {
      DemoTool: tool({
        description: "A demo tool",
        args: {
          input: tool.schema.string().describe("Input to process"),
        },
        async execute(args) {
          return `Processed: ${args.input}`
        },
      }),
    },
  }
}
