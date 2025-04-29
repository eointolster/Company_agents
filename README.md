I start Company agents with Docker Desktop on windows with 
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build

I tear it down when I find a bug with
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
docker builder prune -a -f
docker image prune -a -f 
docker system prune -a --volumes -f

Create your .env file as it says below.


# Company Agents

## Description

"Company Agents" is a web application designed to manage employee tasks, track progress, and facilitate communication within a company[cite: 93]. It uniquely integrates AI capabilities, specifically Large Language Models (LLMs), via different "agents" running in background worker processes to automate or assist with specific tasks like processing employee profile updates and breaking down new tasks into actionable steps[cite: 93, 108]. The system features role-based interfaces, real-time updates via WebSockets, and an organizational chart visualization[cite: 37, 39, 47].

## Architecture Overview

The system utilizes a Node.js backend employing the `cluster` module to manage a pool of worker processes[cite: 23, 97]. This allows computationally intensive LLM tasks to run concurrently without blocking the main server[cite: 27, 32, 102].

* **Primary Process (`src/server/index.js`):** Handles Express web server, API routes, WebSocket connections, and coordinates task assignments to workers[cite: 25, 94, 95, 97].
* **Worker Processes (`src/workers/agent_worker.js`):** Execute specific agent workflows (e.g., task breakdown, profile parsing) involving LLM interactions[cite: 27, 99, 100].
* **Database (`src/db/sqlite.js`):** Uses SQLite for persistent storage of users, tasks, steps, etc[cite: 43, 103].
* **Frontend (`public/`):** Static HTML, CSS, and JavaScript files providing user interfaces for login, registration, admin dashboards, and employee views[cite: 37, 38].

## Prerequisites

* [Node.js](https://nodejs.org/) (Check `package.json` for version compatibility, requires >=12 generally)
* [npm](https://www.npmjs.com/) (Usually comes with Node.js)
* [Docker](https://www.docker.com/) & [Docker Compose](https://docs.docker.com/compose/) (Required for Docker-based setup)

## Setup

1.  **Clone the Repository:**
    ```bash
    git clone <your-repository-url>
    cd company-agents
    ```

2.  **Install Dependencies:**
    ```bash
    npm install
    ```
    This installs packages listed in `package.json`.

3.  **Configure Environment Variables:**
    Create a `.env` file in the root of the project directory. Add the following required and optional variables:

    ```dotenv
    # Required
    JWT_SECRET=your_strong_jwt_secret_here # Change this for security
    OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx # Your OpenAI API Key
    # Add other LLM API keys if needed (e.g., GOOGLE_API_KEY, ANTHROPIC_API_KEY)

    # Optional (Defaults are in src/config.js)
    # PORT_HTTP=3000
    # PORT_WS=3001
    # MIN_WORKERS=1
    # MAX_WORKERS=3 # Adjust based on your CPU cores
    # SUMMARY_CRON='59 23 * * *'
    ```

## Running the Application

You can run the application using Node.js directly or via Docker Compose.

### Method 1: Node.js (Development)

This method uses `nodemon` for automatic restarts when code changes.

```bash
npm run dev
