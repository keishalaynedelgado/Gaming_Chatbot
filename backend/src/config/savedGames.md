# Saved Games

## Purpose

This file defines how the chatbot handles games that already exist. These games are treated as reusable templates, not new generation tasks. The server reads this file on every request, so edits apply immediately — no restart needed.

## Rule

When the user's request matches any saved game below, skip planning entirely and immediately return the existing generated version.

Do not:

- create a new plan,
- explain how to build it,
- regenerate the project,
- rewrite existing files,
- ask clarifying questions,
- start the planning pipeline.

Instead, instantly load and return the previously generated project (a copy in a new chat, so changes asked for there never touch the original).

## Saved Games

Format the server reads for each game:

- a `### Game name` heading,
- a `Project:` line with the id of the chat that holds the finished game,
- a `Triggers` list — matched case- and punctuation-insensitively, with `&` read as `and`. Plain "make / create / build / generate (a) *name* (game / clone)" phrasings of the game's name match too.

### Snake and Ladder

Project: ce447348-c7c5-4f67-ba05-553065af5d7b

Triggers

- create snake and ladder
- make snake and ladder
- snake and ladder
- build snake and ladder

Action: Return the existing Snake and Ladder project immediately.

### Flappy Bird

Project: 31f1886d-8a2c-4eda-88df-9a46370bed47

Triggers

- create flappy bird
- make flappy bird
- flappy bird
- build flappy bird

Action: Return the existing Flappy Bird project immediately.

### Collect & Dodge

Project: 697f7a40-da6d-439d-82d4-2cc80889866d

Triggers

- create collect & dodge
- make collect & dodge
- collect and dodge
- collect & dodge
- build collect & dodge

Action: Return the existing Collect & Dodge project immediately.

### Nikki Run

Project: b000291a-ee65-4e99-85d3-3f112edeb23c

Triggers

- create nikki run
- make nikki run
- nikki run
- build nikki run

Action: Return the existing Nikki Run project immediately.

## Priority

1. Check whether the user's request matches a saved game.
2. If it matches, immediately return the existing project.
3. Skip the planner, orchestrator, repair flow, and generation pipeline.
4. Only use the normal planning and generation flow if the requested game is not in the saved games list.

## Expected Behavior

| User Request | Response |
| --- | --- |
| "Create Flappy Bird." | Return the existing Flappy Bird project immediately. |
| "Make Snake and Ladder." | Return the existing Snake and Ladder project immediately. |
| "Build Nikki Run." | Return the existing Nikki Run project immediately. |
| "Create Collect & Dodge." | Return the existing Collect & Dodge project immediately. |
| "Create a Zombie Wave Shooter." | Use the normal planning and generation flow because it is not a saved game. |
