---
title: Use generative AI
description: Connect your own OpenAI or Google Gemini account in Pigment, then fill a selection, expand the canvas, generate images, backgrounds and skies, describe an image or ask the Assistant.
order: 60
verified: 0.5.0
---

Open **Edit › AI Accounts…**, paste an API key from OpenAI or Google Gemini, press **Connect** and tick the agreement. Then select an area and choose **Edit › Generative Fill…**. Generative AI is optional: without an account Pigment works as usual and sends nothing.

## Connect an account

1. Get an API key from [OpenAI](https://platform.openai.com/api-keys) or [Google AI Studio](https://aistudio.google.com/apikey). **Get a key…** in the dialog opens the same page.
2. Choose **Edit › AI Accounts…** (or the **AI Accounts…** button in **Preferences › AI Integrations**).
3. On the provider's tab, paste the key into **API key** and press **Connect**. Pigment asks the provider for its list of models to check the key, then keeps it: in the macOS Keychain, the Windows Credential Manager, or on Linux in `ai-keys.json` in Pigment's settings folder, readable only by you but not encrypted.
4. Tick the agreement that the AI commands send your prompt and, where a feature needs it, the image, layer or selection to your provider, and that the provider bills your account for every request.

Nothing leaves your computer before you agree, and afterwards only when you run a feature. Keys from Pigment 0.4 are not carried over: enter them again.

**Sign in with ChatGPT** on the OpenAI tab uses a ChatGPT Plus or Pro plan instead of a key, for the Assistant and Describe Image only. It is marked **Experimental**: it uses a route OpenAI has not documented as a stable service and could not be tested against the real one. The image features always need an API key.

## The features

| Feature | Where | What it does |
|---|---|---|
| **Generative Fill** | **Edit › Generative Fill…**, the bar under a selection, or right-click a selection | Fills the selection with what you describe, using the image around it. 1 to 3 **Variations**, each on a new layer. |
| **Generative Expand** | The Crop tool's bar when the crop frame reaches past the canvas, or the command palette | Enlarges the canvas and fills the new area so the picture continues. |
| **Generate Image** | **Edit › Generate Image…** | Makes a picture from a description, as a new layer or a new document, with a **Transparent background** if you like. |
| **Remove Background** | **Layer › Remove Background** | Masks the layer down to its subject on your computer. Needs no account and sends nothing. |
| **Remove Background with AI Provider** | **Layer › Remove Background with AI Provider** | The same, with the subject found by your provider. Needs a pixel layer: rasterize a type or shape layer first. |
| **Generate Background** | **Layer › Generate Background…**, or the bar after Remove Background | Keeps the subject and generates new surroundings, on a new layer. |
| **Sky Replacement** | **Edit › Sky Replacement…** | Generates a new sky. The sky is your selection, or the one **Select › Sky** finds. |
| **Describe Image** | **Image › Describe Image…** | Describes the picture in words, to copy or to keep as the document's description in **File › File Info…**. |
| **Assistant** | **Window › Assistant** | A chat about the open document that can also edit it: adjustments, filters, layers, selections, text and Generative Fill. |

Every feature is also in the command palette (Cmd+F). There is no AI menu: the features sit where Photoshop puts them.

## Run a feature

1. For Generative Fill, select the area first, for example with the **Lasso Tool**.
2. Open the feature. Its window says what it will send.
3. Describe what you want and press **Generate**.
4. While the request runs, the status bar shows it with **Cancel**, and the window shows **Stop**. The document waits until the answer lands; you can work in other documents meanwhile.
5. The result lands on a new layer (or as a layer mask) in one undo step. Your original pixels are not changed. **Edit › Undo** takes it back.

A request you stop after it was sent may still be billed by your provider.

## Good to know

- **Models** are chosen automatically from your provider's list. To pick one, type its name in **Chat model** or **Image model** in AI Accounts (**Use Suggested** fills in the automatic choice), or in the feature's **Model:** field for one request.
- **Actions never call a provider.** A recorded action, a batch or a droplet skips the AI steps, so replaying an action never spends money. **Layer › Remove Background**, which sends nothing, is recorded.
- **AI agents and scripts** (MCP, the control channel, `pigment-cli run`) can use these features only while **Allow agents to run AI commands** is on in AI Accounts, or with `--allow-ai` on the command line.
- **From the command line**, `pigment-cli ai status`, `ai set-key`, `ai consent`, `ai test` and `ai sign-in` do what AI Accounts does.
- The AI windows are in English in every interface language.
- These features were tested against stand-ins for the two providers, not with live accounts. If your account behaves differently, please [report it](../troubleshooting/get-help.md).
