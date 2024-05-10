# Variable: gemini15Pro

```ts
const gemini15Pro: ModelReference<ZodObject<{
  "maxOutputTokens": ZodOptional<ZodNumber>;
  "safetySettings": ZodOptional<ZodArray<ZodObject<{
     "category": ZodEnum<["HARM_CATEGORY_UNSPECIFIED", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_DANGEROUS_CONTENT"]>;
     "threshold": ZodEnum<["BLOCK_LOW_AND_ABOVE", "BLOCK_MEDIUM_AND_ABOVE", "BLOCK_ONLY_HIGH", "BLOCK_NONE"]>;
    }, "strip", ZodTypeAny, {
     "category":   | "HARM_CATEGORY_UNSPECIFIED"
        | "HARM_CATEGORY_HATE_SPEECH"
        | "HARM_CATEGORY_SEXUALLY_EXPLICIT"
        | "HARM_CATEGORY_HARASSMENT"
        | "HARM_CATEGORY_DANGEROUS_CONTENT";
     "threshold": "BLOCK_LOW_AND_ABOVE" | "BLOCK_MEDIUM_AND_ABOVE" | "BLOCK_ONLY_HIGH" | "BLOCK_NONE";
    }, {
     "category":   | "HARM_CATEGORY_UNSPECIFIED"
        | "HARM_CATEGORY_HATE_SPEECH"
        | "HARM_CATEGORY_SEXUALLY_EXPLICIT"
        | "HARM_CATEGORY_HARASSMENT"
        | "HARM_CATEGORY_DANGEROUS_CONTENT";
     "threshold": "BLOCK_LOW_AND_ABOVE" | "BLOCK_MEDIUM_AND_ABOVE" | "BLOCK_ONLY_HIGH" | "BLOCK_NONE";
    }>, "many">>;
  "stopSequences": ZodOptional<ZodArray<ZodString, "many">>;
  "temperature": ZodOptional<ZodNumber>;
  "topK": ZodOptional<ZodNumber>;
  "topP": ZodOptional<ZodNumber>;
  "version": ZodOptional<ZodString>;
 }, "strip", ZodTypeAny, {
  "maxOutputTokens": number;
  "safetySettings": {
     "category":   | "HARM_CATEGORY_UNSPECIFIED"
        | "HARM_CATEGORY_HATE_SPEECH"
        | "HARM_CATEGORY_SEXUALLY_EXPLICIT"
        | "HARM_CATEGORY_HARASSMENT"
        | "HARM_CATEGORY_DANGEROUS_CONTENT";
     "threshold": "BLOCK_LOW_AND_ABOVE" | "BLOCK_MEDIUM_AND_ABOVE" | "BLOCK_ONLY_HIGH" | "BLOCK_NONE";
    }[];
  "stopSequences": string[];
  "temperature": number;
  "topK": number;
  "topP": number;
  "version": string;
 }, {
  "maxOutputTokens": number;
  "safetySettings": {
     "category":   | "HARM_CATEGORY_UNSPECIFIED"
        | "HARM_CATEGORY_HATE_SPEECH"
        | "HARM_CATEGORY_SEXUALLY_EXPLICIT"
        | "HARM_CATEGORY_HARASSMENT"
        | "HARM_CATEGORY_DANGEROUS_CONTENT";
     "threshold": "BLOCK_LOW_AND_ABOVE" | "BLOCK_MEDIUM_AND_ABOVE" | "BLOCK_ONLY_HIGH" | "BLOCK_NONE";
    }[];
  "stopSequences": string[];
  "temperature": number;
  "topK": number;
  "topP": number;
  "version": string;
}>>;
```

## Source

[plugins/googleai/src/gemini.ts:106](https://github.com/firebase/genkit/blob/9cb10ef63dd6659f1a31ffd2367b7efa8acc10e5/js/plugins/googleai/src/gemini.ts#L106)