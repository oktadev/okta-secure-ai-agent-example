#!/usr/bin/env node
/**
 * validate-opa-secrets.ts - Validate OPA secrets configuration
 *
 * This script validates:
 * 1. .env.opa file exists and has required variables
 * 2. OPA connection is working
 * 3. Secrets can be retrieved
 */
import chalk from 'chalk';
import ora from 'ora';
import * as fs from 'fs';
import * as path from 'path';
import { createOPAClientFromCredentials } from './lib/opa-api.js';
// ============================================================================
// Helper Functions
// ============================================================================
/**
 * Load environment variables from .env file
 */
function loadEnvFile(filePath) {
    const absolutePath = path.resolve(filePath);
    if (!fs.existsSync(absolutePath)) {
        throw new Error(`Environment file not found: ${absolutePath}`);
    }
    const content = fs.readFileSync(absolutePath, 'utf8');
    const env = {};
    content.split('\n').forEach((line) => {
        line = line.trim();
        if (line && !line.startsWith('#')) {
            const [key, ...valueParts] = line.split('=');
            if (key && valueParts.length > 0) {
                env[key.trim()] = valueParts.join('=').trim();
            }
        }
    });
    return env;
}
/**
 * Mask sensitive values for display
 */
function maskSecret(value, showChars = 8) {
    if (!value)
        return '<not set>';
    if (value.length <= showChars * 2)
        return '*'.repeat(value.length);
    return value.substring(0, showChars) + '...' + value.substring(value.length - 4);
}
// ============================================================================
// Validation Functions
// ============================================================================
/**
 * Test: Validate .env.opa file exists and has required variables
 */
async function validateEnvFile() {
    const envPath = 'packages/agent0/.env.opa';
    if (!fs.existsSync(envPath)) {
        return {
            passed: false,
            message: '.env.opa file not found',
            details: {
                expected: envPath,
                tip: 'Run `pnpm run setup:opa-secrets` to create it',
            },
        };
    }
    try {
        const env = loadEnvFile(envPath);
        const required = [
            'OPA_BASE_URL',
            'OPA_TEAM_NAME',
            'OPA_KEY_ID',
            'OPA_KEY_SECRET',
            'OPA_RESOURCE_GROUP_ID',
            'OPA_PROJECT_ID',
            'OPA_LLM_PROVIDER',
        ];
        const missing = required.filter((key) => !env[key]);
        if (missing.length > 0) {
            return {
                passed: false,
                message: 'Missing required environment variables',
                details: { missing },
            };
        }
        // Check for recommended variables
        const warnings = [];
        if (!env.OPA_FOLDER_ID) {
            warnings.push('OPA_FOLDER_ID not set (secrets will be searched at project level)');
        }
        if (env.OPA_LLM_PROVIDER === 'anthropic' && !env.OPA_ANTHROPIC_SECRET_NAME) {
            warnings.push('OPA_ANTHROPIC_SECRET_NAME not set (will default to ANTHROPIC_API_KEY)');
        }
        return {
            passed: true,
            message: '.env.opa is properly configured',
            details: {
                baseUrl: env.OPA_BASE_URL,
                teamName: env.OPA_TEAM_NAME,
                provider: env.OPA_LLM_PROVIDER,
                keyId: maskSecret(env.OPA_KEY_ID),
            },
            warning: warnings.length > 0 ? warnings.join('; ') : undefined,
        };
    }
    catch (error) {
        const err = error;
        return {
            passed: false,
            message: `Failed to parse .env.opa: ${err.message}`,
        };
    }
}
/**
 * Test: Validate OPA connection
 */
async function validateOPAConnection(env) {
    if (!env.OPA_BASE_URL || !env.OPA_TEAM_NAME || !env.OPA_KEY_ID || !env.OPA_KEY_SECRET) {
        return {
            passed: false,
            message: 'Missing OPA connection credentials',
        };
    }
    try {
        const client = await createOPAClientFromCredentials(env.OPA_BASE_URL, env.OPA_TEAM_NAME, env.OPA_KEY_ID, env.OPA_KEY_SECRET);
        // Test by listing resource groups (simple API call)
        const resourceGroups = await client.listResourceGroups();
        return {
            passed: true,
            message: 'OPA connection successful',
            details: {
                endpoint: env.OPA_BASE_URL,
                team: env.OPA_TEAM_NAME,
                resourceGroupsFound: resourceGroups.length,
            },
        };
    }
    catch (error) {
        const err = error;
        let hint = '';
        if (err.message.includes('401')) {
            hint = 'Check OPA_KEY_ID and OPA_KEY_SECRET';
        }
        else if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED')) {
            hint = 'Check OPA_BASE_URL';
        }
        return {
            passed: false,
            message: `OPA connection failed: ${err.message}`,
            details: hint ? { hint } : undefined,
        };
    }
}
/**
 * Test: Validate secrets can be listed
 */
async function validateSecretsAccess(env, client) {
    if (!env.OPA_RESOURCE_GROUP_ID || !env.OPA_PROJECT_ID) {
        return {
            passed: false,
            message: 'Missing resource group or project ID',
        };
    }
    try {
        const secrets = await client.listSecretsInProject(env.OPA_RESOURCE_GROUP_ID, env.OPA_PROJECT_ID, env.OPA_FOLDER_ID);
        const secretNames = secrets.map((s) => s.name);
        return {
            passed: true,
            message: `Found ${secrets.length} secret(s) in folder`,
            details: {
                secrets: secretNames,
                folderId: env.OPA_FOLDER_ID || '<project root>',
            },
        };
    }
    catch (error) {
        const err = error;
        return {
            passed: false,
            message: `Failed to list secrets: ${err.message}`,
            details: {
                resourceGroupId: env.OPA_RESOURCE_GROUP_ID,
                projectId: env.OPA_PROJECT_ID,
                folderId: env.OPA_FOLDER_ID,
            },
        };
    }
}
/**
 * Test: Validate secret retrieval (reveal)
 */
async function validateSecretRetrieval(env, client, secretName) {
    if (!env.OPA_RESOURCE_GROUP_ID || !env.OPA_PROJECT_ID) {
        return {
            passed: false,
            message: 'Missing resource group or project ID',
        };
    }
    try {
        // Find the secret by name
        const secret = await client.getSecretByName(env.OPA_RESOURCE_GROUP_ID, env.OPA_PROJECT_ID, secretName, env.OPA_FOLDER_ID);
        if (!secret) {
            return {
                passed: false,
                message: `Secret not found: ${secretName}`,
                details: {
                    searchedIn: env.OPA_FOLDER_ID || '<project root>',
                },
            };
        }
        // Reveal the secret
        const revealed = await client.revealSecret(env.OPA_RESOURCE_GROUP_ID, env.OPA_PROJECT_ID, secret.id);
        return {
            passed: true,
            message: `Secret "${secretName}" retrieved successfully`,
            details: {
                secretId: secret.id,
                value: maskSecret(revealed.secret, 10),
            },
        };
    }
    catch (error) {
        const err = error;
        return {
            passed: false,
            message: `Failed to retrieve secret "${secretName}": ${err.message}`,
        };
    }
}
// ============================================================================
// Main Validation
// ============================================================================
async function validate() {
    console.log(chalk.bold.blue('\n🔐 Validating OPA Secrets Configuration\n'));
    // Load environment file
    let env = {};
    try {
        env = loadEnvFile('packages/agent0/.env.opa');
    }
    catch (error) {
        const err = error;
        console.error(chalk.red('❌ Failed to load .env.opa:'), err.message);
        console.log(chalk.yellow('\n💡 Run `pnpm run setup:opa-secrets` first\n'));
        process.exit(1);
    }
    let client = null;
    let passedCount = 0;
    let failedCount = 0;
    // Test 1: Validate env file
    const spinner1 = ora('Validating .env.opa file').start();
    const envResult = await validateEnvFile();
    if (envResult.passed) {
        spinner1.succeed(chalk.green(`Environment: ${envResult.message}`));
        if (envResult.details) {
            console.log(chalk.gray('  Details:'), envResult.details);
        }
        if (envResult.warning) {
            console.log(chalk.yellow('  Warning:'), envResult.warning);
        }
        passedCount++;
    }
    else {
        spinner1.fail(chalk.red(`Environment: ${envResult.message}`));
        if (envResult.details) {
            console.log(chalk.gray('  Details:'), envResult.details);
        }
        failedCount++;
    }
    // Test 2: Validate OPA connection
    const spinner2 = ora('Testing OPA connection').start();
    const connResult = await validateOPAConnection(env);
    if (connResult.passed) {
        spinner2.succeed(chalk.green(`Connection: ${connResult.message}`));
        if (connResult.details) {
            console.log(chalk.gray('  Details:'), connResult.details);
        }
        passedCount++;
        // Create client for subsequent tests
        client = await createOPAClientFromCredentials(env.OPA_BASE_URL, env.OPA_TEAM_NAME, env.OPA_KEY_ID, env.OPA_KEY_SECRET);
    }
    else {
        spinner2.fail(chalk.red(`Connection: ${connResult.message}`));
        if (connResult.details) {
            console.log(chalk.gray('  Details:'), connResult.details);
        }
        failedCount++;
    }
    // Test 3: Validate secrets access (only if connection succeeded)
    if (client) {
        const spinner3 = ora('Listing secrets in folder').start();
        const accessResult = await validateSecretsAccess(env, client);
        if (accessResult.passed) {
            spinner3.succeed(chalk.green(`Secrets Access: ${accessResult.message}`));
            if (accessResult.details) {
                console.log(chalk.gray('  Details:'), accessResult.details);
            }
            passedCount++;
        }
        else {
            spinner3.fail(chalk.red(`Secrets Access: ${accessResult.message}`));
            if (accessResult.details) {
                console.log(chalk.gray('  Details:'), accessResult.details);
            }
            failedCount++;
        }
        // Test 4: Validate Anthropic API key retrieval
        if (env.OPA_LLM_PROVIDER === 'anthropic') {
            const apiKeySecretName = env.OPA_ANTHROPIC_SECRET_NAME || 'ANTHROPIC_API_KEY';
            const spinner4 = ora(`Retrieving secret: ${apiKeySecretName}`).start();
            const apiKeyResult = await validateSecretRetrieval(env, client, apiKeySecretName);
            if (apiKeyResult.passed) {
                spinner4.succeed(chalk.green(`API Key: ${apiKeyResult.message}`));
                if (apiKeyResult.details) {
                    console.log(chalk.gray('  Details:'), apiKeyResult.details);
                }
                passedCount++;
            }
            else {
                spinner4.fail(chalk.red(`API Key: ${apiKeyResult.message}`));
                if (apiKeyResult.details) {
                    console.log(chalk.gray('  Details:'), apiKeyResult.details);
                }
                failedCount++;
            }
            // Test 5: Validate model retrieval (if configured)
            if (env.OPA_ANTHROPIC_MODEL_SECRET_NAME) {
                const spinner5 = ora(`Retrieving secret: ${env.OPA_ANTHROPIC_MODEL_SECRET_NAME}`).start();
                const modelResult = await validateSecretRetrieval(env, client, env.OPA_ANTHROPIC_MODEL_SECRET_NAME);
                if (modelResult.passed) {
                    spinner5.succeed(chalk.green(`Model: ${modelResult.message}`));
                    if (modelResult.details) {
                        console.log(chalk.gray('  Details:'), modelResult.details);
                    }
                    passedCount++;
                }
                else {
                    spinner5.fail(chalk.red(`Model: ${modelResult.message}`));
                    if (modelResult.details) {
                        console.log(chalk.gray('  Details:'), modelResult.details);
                    }
                    failedCount++;
                }
            }
        }
        // Test for Bedrock provider
        if (env.OPA_LLM_PROVIDER === 'bedrock') {
            const accessKeyName = env.OPA_AWS_ACCESS_KEY_ID_SECRET_NAME || 'AWS_ACCESS_KEY_ID';
            const secretKeyName = env.OPA_AWS_SECRET_ACCESS_KEY_SECRET_NAME || 'AWS_SECRET_ACCESS_KEY';
            const spinner4 = ora(`Retrieving AWS credentials`).start();
            const accessKeyResult = await validateSecretRetrieval(env, client, accessKeyName);
            const secretKeyResult = await validateSecretRetrieval(env, client, secretKeyName);
            if (accessKeyResult.passed && secretKeyResult.passed) {
                spinner4.succeed(chalk.green('AWS Credentials: Retrieved successfully'));
                passedCount++;
            }
            else {
                spinner4.fail(chalk.red('AWS Credentials: Failed to retrieve'));
                if (!accessKeyResult.passed) {
                    console.log(chalk.gray(`  ${accessKeyName}:`), accessKeyResult.message);
                }
                if (!secretKeyResult.passed) {
                    console.log(chalk.gray(`  ${secretKeyName}:`), secretKeyResult.message);
                }
                failedCount++;
            }
        }
    }
    // Summary
    const totalTests = passedCount + failedCount;
    console.log(chalk.bold('\n📊 Validation Summary\n'));
    console.log(`  ${chalk.green('Passed:')} ${passedCount}/${totalTests}`);
    console.log(`  ${chalk.red('Failed:')} ${failedCount}/${totalTests}\n`);
    if (failedCount === 0) {
        console.log(chalk.bold.green('✅ All OPA validations passed!\n'));
        console.log('Your OPA secrets are ready to use with agent0.\n');
        process.exit(0);
    }
    else {
        console.log(chalk.bold.red('❌ Some validations failed\n'));
        console.log(chalk.yellow('💡 Tips:'));
        console.log('  • Check .env.opa has correct credentials');
        console.log('  • Verify OPA_KEY_ID and OPA_KEY_SECRET are valid');
        console.log('  • Ensure secrets exist in the configured folder');
        console.log('  • Try re-running: pnpm run setup:opa-secrets\n');
        process.exit(1);
    }
}
// Run validation
validate().catch((error) => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
});
