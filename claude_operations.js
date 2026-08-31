// Import modules
import Anthropic from "@anthropic-ai/sdk";

export class ClaudeOperations {
    constructor(file_context, anthropic_key, model_name, history_length) {
        // Anthropic's Messages API takes the system prompt as a separate top-level
        // param, not as a message in the array (unlike OpenAI's chat.completions).
        // file_context is therefore stored separately; this.messages holds only
        // user/assistant turns.
        this.system_prompt = file_context;
        this.messages = [];
        this.anthropic = new Anthropic({
            apiKey: anthropic_key,
        });
        this.model_name = model_name;
        this.history_length = history_length;
    }

    check_history_length() {
        // Use template literals to concatenate strings
        console.log(`Conversations in History: ${(this.messages.length / 2)}/${this.history_length}`);
        // No system message occupies a slot in this.messages (see constructor note),
        // so the +1 offset the OpenAI version needed is not needed here.
        if (this.messages.length > (this.history_length * 2)) {
            console.log('Message amount in history exceeded. Removing oldest user and agent messages.');
            this.messages.splice(0, 2);
        }
    }

    async make_claude_call(text) {
        try {
            // Add user message to messages
            this.messages.push({role: "user", content: text});

            // Check if message history is exceeded
            this.check_history_length();

            // Use await to get the response from Claude
            // Prompt caching (post-S3, 3 Jul 2026): the system prompt (file_context.txt,
            // ~10k tokens of roster + persona) is now wrapped as a cached content block
            // instead of a bare string. It's re-sent on every call (mentions, !song,
            // shoutouts) and is ~85-90% of the bot's token cost — caching cuts that
            // ~85-90% on every call that hits within the 5-min ephemeral cache window,
            // which comfortably covers live-stream call cadence. temperature stays 1;
            // deliberately NOT adding top_p (that 400s alongside temperature — the S1 bug).
            const response = await this.anthropic.messages.create({
                model: this.model_name,
                system: [
                    { type: "text", text: this.system_prompt, cache_control: { type: "ephemeral" } }
                ],
                messages: this.messages,
                // 11 Aug 2026: was 256. A shoutout ran to 964 chars (~241 tokens) and was
                // CUT MID-SENTENCE at the ceiling. 300 gives ~1,130 chars — enough for the
                // model to land its final sentence past the 800-char target, without
                // licensing a 1,600-char reply (Max ruled against that ceiling explicitly).
                // ⛔ This is a GUARDRAIL, not a length control. The length rule lives in
                // file_context.txt; raising this instead of fixing that is the wrong fix.
                // ⛔⛔ THIS IS A BACKSTOP, NOT THE LENGTH CONTROL. Inverted 30 Aug 2026.
                //
                // ⚠ THIS REVERSES AN EARLIER RULING OF MAX'S THE SAME DAY — "200, NOT 300
                // ... at 300 the model FILLS the budget, 1,182 characters, severed at the
                // ceiling anyway. A prompt asking for brevity cannot beat the budget."
                // ⇒ Reversed by him on 30 Aug after the premise was falsified, NOT ignored.
                //
                // ⭐ WHY THE PREMISE FELL: that 300 test ran against the OLD prompt, which
                // opened "one long, winding, unhurried statement -- follow the thought
                // wherever it leads" and bolted brevity on at the end. It was not a prompt
                // asking for brevity; it was a prompt asking for LENGTH that also asked for
                // brevity, and the first clause set the shape. The budget was never what it
                // was losing to.
                //
                // ✅ [measured on Philo_B0t 30 Aug 23:54, same file, ceiling 300, NEW prompt]
                //   output=198 stop=end_turn — 102 tokens of headroom left UNUSED, exactly
                //   five sentences, finished on its own. The model does NOT simply fill
                //   whatever room it is given; it fills whatever room the PROMPT implies.
                //
                // ⇒ Length now comes from file_context.txt ("FOUR OR FIVE SENTENCES at
                //   most"), which is countable. A token ceiling is not — the model cannot
                //   count its own tokens, so a ceiling can only ever AMPUTATE.
                // ⇒ If replies get LONGER, the prompt lost. Fix the prompt. Do NOT reach
                //   for this number — three rounds (300→200→250) already proved that path.
                //
                // ⚠ This is the ONLY max_tokens in the bot and every Claude path uses it:
                // triggers, !song, welcomes, thanks, shoutouts, idle chatter, hype trains.
                // Env-overridable so it can be retuned on Render without a deploy.
                max_tokens: Number(process.env.MAX_TOKENS || 300),
                temperature: 1,
            });

            // Log token usage incl. cache read/write so cache hits are visible in Render
            // logs (verification checklist wants a cache_read_input_tokens sighting on a
            // repeat call).
            if (response.usage) {
                console.log(`Usage: input=${response.usage.input_tokens} cache_creation=${response.usage.cache_creation_input_tokens ?? 0} cache_read=${response.usage.cache_read_input_tokens ?? 0} output=${response.usage.output_tokens} stop=${response.stop_reason}`);
                // ⛔ stop=max_tokens means the model was CUT, not that it finished.
                // completeSentencesOnly() removes the severed clause, so a truncated
                // reply and a landed one look IDENTICAL in chat. This field is the
                // only thing that tells them apart — and its absence is why three
                // rounds of ceiling-tuning were spent guessing.
                if (response.stop_reason === "max_tokens") {
                    console.log(`⛔ TRUNCATED at the ${response.usage.output_tokens}-token ceiling — the ending was cut, then trimmed away.`);
                }
            }

            // Check if response has content
            if (response.content && response.content.length > 0) {
                let agent_response = response.content
                    .filter(block => block.type === "text")
                    .map(block => block.text)
                    .join("");
                console.log(`Agent Response: ${agent_response}`);
                this.messages.push({role: "assistant", content: agent_response});
                return agent_response;
            } else {
                // Handle the case when no content is returned
                throw new Error("No content returned from Claude");
            }
        } catch (error) {
            // Handle any errors that may occur
            console.error(error);
            return "Sorry, something went wrong. Please try again later.";
        }
    }

    async make_claude_call_completion(text) {
        // PROMPT mode is dead legacy (GPT_MODE stays "CHAT" per the guardrails) and was
        // already broken upstream (hardcoded to the retired text-davinci-003 model).
        // Not ported to Claude — this stub exists only so index.js's untouched PROMPT
        // branch has something to call instead of throwing if it's ever hit.
        console.log("PROMPT mode is not supported by the Claude backend. GPT_MODE must stay CHAT.");
        return "PROMPT mode is not supported.";
    }
}
