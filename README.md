# DevTracker

An offline, framework-free engineering workspace that preserves context between a human tech lead and AI development agents.

Open `index.html` in a modern browser or run the project as a desktop application with Electron.

The application uses browser `localStorage`; Export produces the same JSON workspace shape that Import consumes.

## Core loop

1. Select an unblocked ticket and copy its session brief.
2. Work with an AI assistant.
3. Ask the assistant to end with the included Session Report format.
4. Paste the report back into DevTracker to update acceptance criteria and session history.

## Desktop app

Install dependencies and start the desktop app from the project root:

```bash
npm install
npm start
```

In the Electron app, the sidebar now includes a Git view that displays the local repository history for the current project.

Build a macOS `.dmg` installer from the project root with:

```bash
npm run dist
```

The packaged DMG will be written to the `dist/` directory.
