/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Genkit, z } from 'genkit';
import { GenkitPlugin, genkitPlugin } from 'genkit/plugin';
import { GoogleAuth, GoogleAuthOptions } from 'google-auth-library';
import {
  VertexAIEvaluationMetric,
  VertexAIEvaluationMetricType,
  vertexEvaluators,
} from './evaluation.js';
export {
  VertexAIEvaluationMetricType as VertexAIEvaluationMetricType,
};

export interface PluginOptions {
  /** The Google Cloud project id to call. */
  projectId?: string;
  /** The Google Cloud region to call. */
  location: string;
  /** Provide custom authentication configuration for connecting to Vertex AI. */
  googleAuth?: GoogleAuthOptions;
  /** Configure Vertex AI evaluators */
  evaluation?: {
    metrics: VertexAIEvaluationMetric[];
  };
}

const CLOUD_PLATFROM_OAUTH_SCOPE =
  'https://www.googleapis.com/auth/cloud-platform';

/**
 * Add Google Cloud Vertex AI to Genkit. Includes Gemini and Imagen models and text embedder.
 */
export function vertexAI(options?: PluginOptions): GenkitPlugin {
  return genkitPlugin('vertexai', async (ai: Genkit) => {
    let authClient;
    let authOptions = options?.googleAuth;

    // Allow customers to pass in cloud credentials from environment variables
    // following: https://github.com/googleapis/google-auth-library-nodejs?tab=readme-ov-file#loading-credentials-from-environment-variables
    if (process.env.GCLOUD_SERVICE_ACCOUNT_CREDS) {
      const serviceAccountCreds = JSON.parse(
        process.env.GCLOUD_SERVICE_ACCOUNT_CREDS
      );
      authOptions = {
        credentials: serviceAccountCreds,
        scopes: [CLOUD_PLATFROM_OAUTH_SCOPE],
      };
      authClient = new GoogleAuth(authOptions);
    } else {
      authClient = new GoogleAuth(
        authOptions ?? { scopes: [CLOUD_PLATFROM_OAUTH_SCOPE] }
      );
    }

    const projectId = options?.projectId || (await authClient.getProjectId());

    const location = options?.location || 'us-central1';
    const confError = (parameter: string, envVariableName: string) => {
      return new Error(
        `VertexAI Plugin is missing the '${parameter}' configuration. Please set the '${envVariableName}' environment variable or explicitly pass '${parameter}' into genkit config.`
      );
    };
    if (!location) {
      throw confError('location', 'GCLOUD_LOCATION');
    }
    if (!projectId) {
      throw confError('project', 'GCLOUD_PROJECT');
    }

    const metrics =
      options?.evaluation && options.evaluation.metrics.length > 0
        ? options.evaluation.metrics
        : [];
    vertexEvaluators(ai, authClient, metrics, projectId, location);
  });
}

export default vertexAI;
