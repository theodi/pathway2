const express = require('express');
const router = express.Router({ mergeParams: true });
const { ensureAuthenticated } = require('../middleware/auth');
const { isMember } = require('../middleware/hubspot');
const { loadProject, checkProjectAccess } = require('../middleware/project');
const Project = require('../models/project');
const Assessment = require('../models/assessment');
const OpenAI = require("openai");
const crypto = require('crypto');

const model = process.env.OPENAI_MODEL || 'gpt-4';
const responseTokens = parseInt(process.env.OPENAI_RESPONSE_TOKENS, 10) || 500;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MAX_WAIT_TIME = 30000; // 30 seconds
const RETRY_INTERVAL = 3000; // 3 seconds
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Function to generate a hash from the user's answers
function generateHash(data) {
    const jsonString = JSON.stringify(data);
    return crypto.createHash('sha256').update(jsonString).digest('hex');
}

async function getAIReponse(prompt, tokens = responseTokens) {
    const completion = await openai.chat.completions.create({
        messages: [
            { role: 'system', content: 'You are a helpful AI assistant that is tasked with turning user answers to a maturity model into human readable summaries of progress and recommendations. Please ensure all responses are in British English spelling. Provide your responses as undeclared HTML.' },
            { role: 'user', content: prompt }
        ],
        model: model,
        max_tokens: tokens,
    });
    return completion.choices[0].message.content;
}

// Helper function to get AI activity summary
async function getAIActivitySummary(activity, dimensionName, levelKeys, assessmentTitle) {
    // 1. Generate the prompt
    const prompt = `
    A user has completed part of a ${assessmentTitle} for the section "${activity.title}" under the "${dimensionName}" part of the assessment. You can find the maturity assessment for just this section in JSON form below with the user answers.

    ${JSON.stringify(activity, null, 2)}

    The levels of maturity are:
    ${levelKeys.map((key, index) => `${index + 1}: ${key}`).join("\n")}

    Create a short human-readable paragraph for this section that describes the areas which show maturity (progress so far) before then focusing on areas of improvement both to achieve the next level of maturity as well as overall. This summary will be placed within the correct section of the report so there is no need to mention the sections this review is for in your response. Start with the summary paragraph and DO NOT include a title or heading at the start.
    `;

    // 2. Make the request to OpenAI
    const response = await getAIReponse(prompt)

    // 3. Return the summary from OpenAI
    return response;
}

async function getOrGenerateActivitySummary(activity, dimensionName, levelKeys, assessmentTitle) {
    // 1. Check if userProgress exists
    if (!activity.userProgress || !activity.userProgress.achievedLevel) {
        // If there's no user progress, return a default message
        return `It is not possible to make any recommendations for ${activity.title} as no questions have been answered.`;
    }

    // 2. Generate the hash of the current user answers
    const currentHash = generateHash(activity.statements.map(s => s.userAnswer));

    // 3. Check if the hash has changed
    if (activity.aiResponse && activity.aiResponse.hash === currentHash) {
        // The hash hasn't changed, return the cached response
        return activity.aiResponse.summary;
    }

    // 4. If the hash has changed or there's no summary, generate a new one
    const summary = await getAIActivitySummary(activity, dimensionName, levelKeys, assessmentTitle);

    // 6. Return the new summary
    return summary;
}

// Helper function to check if all dimension summaries exist
async function checkDimensionSummariesExist(projectData, dimensions) {
    for (const dimension of dimensions) {
        if (!dimension.aiResponse || !dimension.aiResponse.summary) {
            return false;
        }
    }
    return true;
}

// Route to get activity summary
router.get('/:id/assistant/getActivitySummary', ensureAuthenticated, checkProjectAccess, isMember, async (req, res) => {
    try {
        const projectId = req.params.id;
        const { activityTitle } = req.query;

        // 1. Retrieve the project data from the database
        const projectData = await Project.findById(projectId);
        if (!projectData) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // 2. Retrieve the assessment details to get the title
        const assessmentId = projectData.assessment;
        const assessmentData = await Assessment.findById(assessmentId);
        if (!assessmentData) {
            return res.status(404).json({ error: 'Assessment not found' });
        }

        const assessmentTitle = assessmentData.title;

        // 3. Find the dimension and activity data by title
        const dimension = projectData.assessmentData.dimensions.find(dimension =>
            dimension.activities.some(activity => activity.title === activityTitle)
        );

        if (!dimension) {
            return res.status(404).json({ error: 'Dimension not found for the activity' });
        }

        const activity = dimension.activities.find(act => act.title === activityTitle);

        if (!activity) {
            return res.status(404).json({ error: 'Activity not found' });
        }

        // 4. Create a deep copy of the activity object to remove notes before sending to AI
        const activityCopy = JSON.parse(JSON.stringify(activity));

        // 5. Remove notes from userAnswer in the activityCopy
        activityCopy.statements.forEach(statement => {
            if (statement.userAnswer && statement.userAnswer.notes) {
                delete statement.userAnswer.notes;
            }
        });

        // 6. Use the getOrGenerateActivitySummary function with the modified activityCopy
        const levelKeys = ["Initial", "Repeatable", "Defined", "Managed", "Optimising"];
        const summary = await getOrGenerateActivitySummary(activityCopy, dimension.name, levelKeys, assessmentTitle);

        // 7. Generate hash for the current activity state
        const activityHash = generateHash(activity.statements.map(s => s.userAnswer));

        // 8. Update the specific activity's aiResponse in the dimension
        const updateQuery = {
            _id: projectId,
            'assessmentData.dimensions.name': dimension.name,
            'assessmentData.dimensions.activities.title': activityTitle
        };

        const updateAction = {
            $set: {
                'assessmentData.dimensions.$[dim].activities.$[act].aiResponse': {
                    hash: activityHash,
                    summary: summary
                }
            }
        };

        const updateOptions = {
            arrayFilters: [
                { 'dim.name': dimension.name },
                { 'act.title': activityTitle }
            ],
            new: true
        };

        // 9. Perform the update
        await Project.findOneAndUpdate(updateQuery, updateAction, updateOptions);

        // 10. Send the summary as the response
        res.json({ response: summary });

    } catch (error) {
        console.error('Error generating activity summary:', error);
        res.status(500).json({ error: 'An error occurred while generating the summary' });
    }
});

// Route to get dimension summary
router.get('/:id/assistant/getDimensionSummary', ensureAuthenticated, checkProjectAccess, isMember, async (req, res) => {
    try {
        const projectId = req.params.id;
        const { dimensionName } = req.query;

        // 1. Retrieve the project data from the database
        const projectData = await Project.findById(projectId);
        if (!projectData) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // 2. Retrieve the assessment details to get the title
        const assessmentId = projectData.assessment;
        const assessmentData = await Assessment.findById(assessmentId);
        if (!assessmentData) {
            return res.status(404).json({ error: 'Assessment not found' });
        }

        const assessmentTitle = assessmentData.title;

        // 3. Find the dimension by name
        const dimension = projectData.assessmentData.dimensions.find(dim => dim.name === dimensionName);
        if (!dimension) {
            return res.status(404).json({ error: 'Dimension not found' });
        }

        // 4. Prepare the level keys
        const levelKeys = ["Initial", "Repeatable", "Defined", "Managed", "Optimising"];

        // 5. Gather AI Summaries for each activity in the dimension
        const activitySummaries = [];
        for (const activity of dimension.activities) {
            const summary = await getOrGenerateActivitySummary(activity, dimension.name, levelKeys, assessmentTitle);
            activitySummaries.push({ title: activity.title, summary });
        }

        // 6. Generate a hash of the activity summaries to check for changes
        const summaryHash = generateHash(activitySummaries);

        // 7. Check if the dimension summary already exists and hasn't changed
        if (dimension.aiResponse && dimension.aiResponse.hash === summaryHash) {
            // The hash hasn't changed, return the cached response
            return res.json({ summary: dimension.aiResponse.summary });
        }

        // 8. Prepare the prompt with all activity summaries
        let prompt = `A user is completing a maturity assessment entitled ${assessmentTitle}. The following are the activity summaries for the activities under the dimension "${dimension.name}":\n\n`;

        activitySummaries.forEach(({ title, summary }) => {
            prompt += `Activity: ${title}\nSummary: ${summary}\n\n`;
        });

        prompt += "Create a summary of progress in this dimension and provide recommendations on next steps for the user. Start with the summary paragraph and DO NOT include a title or heading at the start.";

        // 9. Generate AI summary for the dimension
        const dimensionSummary = await getAIReponse(prompt);

        // 10. Generate a summary hash to track changes
        const dimensionUpdate = {
            'assessmentData.dimensions.$.aiResponse': {
                hash: summaryHash,
                summary: dimensionSummary
            }
        };

        // 11. Use findOneAndUpdate to update only the matching dimension by name
        await Project.findOneAndUpdate(
            { _id: projectId, 'assessmentData.dimensions.name': dimensionName },
            { $set: dimensionUpdate },
            { new: true }
        );

        // 12. Send the dimension summary as the response
        res.json({ summary: dimensionSummary });

    } catch (error) {
        console.error('Error generating dimension summary:', error);
        res.status(500).json({ error: 'An error occurred while generating the dimension summary' });
    }
});

// Route to get the executive summary
router.get('/:id/assistant/getExecutiveSummary', ensureAuthenticated, checkProjectAccess, isMember, async (req, res) => {
    try {
        const projectId = req.params.id;

        // 1. Retrieve the project data from the database
        let projectData = await Project.findById(projectId);
        if (!projectData) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // 2. Retrieve the assessment details to get the title
        const assessmentId = projectData.assessment;
        const assessmentData = await Assessment.findById(assessmentId);
        if (!assessmentData) {
            return res.status(404).json({ error: 'Assessment not found' });
        }

        const assessmentTitle = assessmentData.title;

        // 3. Get all dimensions
        const dimensions = projectData.assessmentData.dimensions;

        // 4. Wait for dimension summaries to be populated (up to 30 seconds)
        let waitTime = 0;
        while (!(await checkDimensionSummariesExist(projectData, dimensions)) && waitTime < MAX_WAIT_TIME) {
            await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL));
            waitTime += RETRY_INTERVAL;

            // Reload the project data to check for updates
            projectData = await Project.findById(projectId);
        }

        // 5. If dimension summaries still don't exist, return an error
        if (!(await checkDimensionSummariesExist(projectData, dimensions))) {
            return res.status(500).json({ error: 'Dimension summaries could not be generated in time.' });
        }

        // 6. Gather the AI Summaries for all dimensions
        const dimensionSummaries = dimensions.map(dim => ({
            name: dim.name,
            summary: dim.aiResponse.summary
        }));

        // 7. Generate a hash of the dimension summaries to check for changes
        const summaryHash = generateHash(dimensionSummaries);

        // 8. Check if the executive summary already exists and hasn't changed
        if (projectData.assessmentData.aiExecutiveSummary &&
            projectData.assessmentData.aiExecutiveSummary.hash === summaryHash) {
            // The hash hasn't changed, return the cached response
            return res.json({ summary: projectData.assessmentData.aiExecutiveSummary.summary });
        }

        // 9. Prepare the prompt with all dimension summaries
        let prompt = `A user is completing a maturity assessment entitled ${assessmentTitle}. The following are the dimension summaries:\n\n`;

        dimensionSummaries.forEach(({ name, summary }) => {
            prompt += `Dimension: ${name}\nSummary: ${summary}\n\n`;
        });

        prompt += "Create an executive summary that provides an overall assessment of the user's progress and offers recommendations for next steps. Start with the summary paragraph and DO NOT include a title or heading at the start.";

        // 10. Generate AI summary for the executive summary
        const executiveSummary = await getAIReponse(prompt,(responseTokens * 2));

        // 11. Cache the executive summary and hash
        projectData.assessmentData.aiExecutiveSummary = {
            hash: summaryHash,
            summary: executiveSummary
        };

        // 12. Mark the specific path as modified
        projectData.markModified('assessmentData.aiExecutiveSummary');

        // 13. Save the updated project data with the cached executive summary
        await projectData.save();

        // 14. Send the executive summary as the response
        res.json({ summary: executiveSummary });

    } catch (error) {
        console.error('Error generating executive summary:', error);
        res.status(500).json({ error: 'An error occurred while generating the executive summary' });
    }
});

module.exports = router;