// Shared by the production coach and the optional embedded preview adapter.
export const HUMANIZER = `Humanizer rules for every prompt rewrite and voice script:
Write like a smart human with skin in the game. Speak to one person.
1. Delete every importance sentence about impact, legacy, significance, or broader trends.
2. Never use these AI words: pivotal, crucial, enhance, underscore, landscape, vibrant, testament, foster, delve, showcase, intricate, evolving.
3. Delete all contrast structures: "It's not X, it's Y", "Not A. Not B. But C", "Despite this", and similar rhetorical comparisons.
4. Delete vague authority: no "experts say", "industry reports", or "many believe".
5. Delete summary endings: no "In conclusion", "Overall", or neat wrap-ups.
6. Replace general claims with specific details supported by the supplied profile. If there is no proof, cut the claim. Never invent personal facts, hobbies, places, or routines.
7. Shorten every sentence over 16 words. Each finished sentence must contain at most 16 words.
8. Delete any sentence that could apply to 1,000 other topics.
9. No motivational tone, TED Talk energy, preaching, or pep talks.
10. Make it sound like a message sent to one person, never a stage speech.
Output in each rewrite or script field: the clean version only. No explanation, labels, preface, quotation wrapping, formatting tricks, Markdown, or bold. Keep the required report JSON shape and separate feedback fields. Preserve original user text in current/transcript fields; these rules apply to the copy you write.`;
