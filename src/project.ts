// Copyright 2023 Joao Eduardo Luis <joao@abysmo.io>
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as core from "@actions/core";
import * as github from "@actions/github";
import { ProjectFieldEntry, ProjectQueryResponse } from "./gql-types";
import {
  Octokit,
  addProjectItem,
  getProjectItem,
  updateIssueStatus,
} from "./helpers";

type ProjectDesc = {
  owner: string;
  projectNumber: number;
  isOrg: boolean;
};

export type DefaultStatus = {
  issues: string;
  prs: string;
};

/**
 * Parses a project URL into a 'ProjectDesc' type.
 *
 * @param url
 * @returns
 */
function parseURL(url: string): ProjectDesc {
  const regex =
    /\/(?<type>orgs|users)\/(?<owner>[^/]+)\/projects\/(?<prjNumber>\d+)/;
  const match = url.match(regex);
  if (match === null) {
    core.error("Invalid project URL");
    throw new Error(`Invalid project URL: ${url}`);
  }

  return {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    owner: match.groups!.owner,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    projectNumber: parseInt(match.groups!.prjNumber),
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    isOrg: match.groups!.type === "orgs",
  };
}

export class Project {
  private octokit: Octokit;
  private desc: ProjectDesc;
  private projectID?: string;
  private fields: { [id: string]: ProjectFieldEntry };
  private defaultStatus: DefaultStatus;

  public constructor(token: string, url: string, defaultStatus: DefaultStatus) {
    this.octokit = github.getOctokit(token);
    this.desc = parseURL(url);
    this.fields = {};
    this.defaultStatus = defaultStatus;
  }

  /**
   * Init project, from its organization/user and number, obtaining its ID, and
   * its fields.
   */
  public async init(): Promise<{ id: string; title: string }> {
    core.debug(
      `project init: owner: ${this.desc.owner}, prj: ${this.desc.projectNumber}, is org: ${this.desc.isOrg}`,
    );

    const projectRes = await this.octokit.graphql<ProjectQueryResponse>(
      `#graphql

      fragment projectV2fields on ProjectV2 {
        id
        title
        fields(first: 20) {
          nodes {
            ... on ProjectV2SingleSelectField {
              id
              name
              options {
                id
                name
              }
            }
          }
        }
      }

      query getProject($owner: String!, $projectNumber: Int!, $isOrg: Boolean!) {
        organization(login: $owner) @include(if: $isOrg) {
          projectV2(number: $projectNumber) {
            ...projectV2fields
          }
        }
        user(login: $owner) @skip(if: $isOrg) {
          projectV2(number: $projectNumber) {
            ...projectV2fields
          }
        }
      }
    `,
      {
        owner: this.desc.owner,
        projectNumber: this.desc.projectNumber,
        isOrg: this.desc.isOrg,
      },
    );

    if (this.desc.isOrg && projectRes.organization === undefined) {
      throw new Error("Expected organization result, found none!");
    } else if (!this.desc.isOrg && projectRes.user === undefined) {
      throw new Error("Expected user result, found none!");
    }

    const prjv2 = this.desc.isOrg
      ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        projectRes.organization!.projectV2
      : // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        projectRes.user!.projectV2;

    const res = {
      id: prjv2.id,
      title: prjv2.title,
    };

    this.projectID = res.id;
    this.initFields(prjv2.fields.nodes);

    return res;
  }

  /**
   * Init project fields map from array obtained via gql.
   * @param fields
   * @returns
   */
  private initFields(fields: ProjectFieldEntry[]): void {
    for (const entry of fields) {
      if (entry.id === undefined) {
        continue;
      }
      this.fields[entry.name] = entry;
    }

    const fieldsStr = Object.keys(this.fields).join(", ");
    core.debug(`Available project fields: ${fieldsStr}`);
  }

  private getStatusField(
    wanted: string,
  ): { fieldID: string; value: { id: string; value: string } } | undefined {
    const statusField = this.fields["Status"];
    if (statusField === undefined) {
      throw new Error("Unexpected undefined 'Status' field");
    }

    const fieldValue = statusField.options.find(
      (entry: { id: string; name: string }) => {
        return entry.name.toLowerCase().includes(wanted.toLowerCase());
      },
    );
    if (fieldValue === undefined) {
      return undefined;
    }
    return {
      fieldID: statusField.id,
      value: {
        id: fieldValue.id,
        value: fieldValue.name,
      },
    };
  }

  /**
   * Adds a given item to the project. After adding to the project, this
   * function will also update the item's status field to match what has been
   * provided as inputs. If the item is already part of the project, simply
   * update the status field.
   *
   * @param itemID The item to be added, its ID.
   * @param isPullRequest Whether the item to be added is a pull request.
   */
  public async addToProject(
    itemID: string,
    isPullRequest: boolean,
  ): Promise<string> {
    core.debug(`addToProject item ID ${itemID}`);

    if (this.projectID === undefined) {
      throw new Error("Expected Project ID to be populated!");
    }

    let item = await getProjectItem(this.octokit, itemID, this.projectID);
    if (item === undefined) {
      core.info(`Adding item '${itemID}' to project '${this.projectID}'`);
      let prjItemID: string | undefined = undefined;
      try {
        prjItemID = await addProjectItem(this.octokit, itemID, this.projectID);
      } catch (err) {
        core.error(`Unable to add item to project: ${err}`);
        throw new Error("Unable to add item to project");
      }

      if (prjItemID === undefined) {
        throw new Error("Undefined project item id returned when adding");
      }

      item = await getProjectItem(this.octokit, itemID, this.projectID);
      if (item === undefined) {
        throw new Error("Unexpected undefined project item after adding");
      }

      if (item.prjItemID !== prjItemID) {
        throw new Error(
          `Project Item ID mismatch! Expected ${item.prjItemID} got ${prjItemID}`,
        );
      }
    } else {
      core.info(`Item already associated with project '${this.projectID}'`);
    }

    const wantedStatus = isPullRequest
      ? this.defaultStatus.prs
      : this.defaultStatus.issues;
    core.info(`Set status to '${wantedStatus}'`);

    const newStatus = this.getStatusField(wantedStatus);
    if (newStatus === undefined) {
      const errStr = `Unable to find status value for '${wantedStatus}'`;
      core.error(errStr);
      throw new Error(errStr);
    }

    await updateIssueStatus(
      this.octokit,
      this.projectID,
      item.prjItemID,
      newStatus.fieldID,
      newStatus.value.id,
    );
    core.info(`Item status set to '${newStatus.value.value}`);

    return item.prjItemID;
  }
}
