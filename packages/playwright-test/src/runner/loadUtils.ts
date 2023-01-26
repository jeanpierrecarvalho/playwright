/**
 * Copyright Microsoft Corporation. All rights reserved.
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

import path from 'path';
import type { TestError } from '../../types/testReporter';
import type { ConfigLoader } from '../configLoader';
import type { LoadError } from '../fixtures';
import { LoaderHost } from '../loaderHost';
import type { Multiplexer } from '../reporters/multiplexer';
import { createRootSuite, filterOnly, filterSuite } from '../suiteUtils';
import type { Suite, TestCase } from '../test';
import { loadTestFilesInProcess } from '../testLoader';
import type { FullConfigInternal } from '../types';
import type { Matcher, TestFileFilter } from '../util';
import { createFileMatcher } from '../util';
import { collectFilesForProjects, collectProjects } from './projectUtils';

type LoadOptions = {
  listOnly: boolean;
  testFileFilters: TestFileFilter[];
  testTitleMatcher: Matcher;
  projectFilter?: string[];
  passWithNoTests?: boolean;
};

export async function loadAllTests(configLoader: ConfigLoader, reporter: Multiplexer, options: LoadOptions, errors: TestError[]): Promise<Suite> {
  const config = configLoader.fullConfig();
  const projects = collectProjects(config, options.projectFilter);
  const filesByProject = await collectFilesForProjects(projects, options.testFileFilters);
  const allTestFiles = new Set<string>();
  for (const files of filesByProject.values())
    files.forEach(file => allTestFiles.add(file));

  // Load all tests.
  const preprocessRoot = await loadTests(configLoader, reporter, allTestFiles, errors);

  // Complain about duplicate titles.
  errors.push(...createDuplicateTitlesErrors(config, preprocessRoot));

  // Filter tests to respect line/column filter.
  filterByFocusedLine(preprocessRoot, options.testFileFilters);

  // Complain about only.
  if (config.forbidOnly) {
    const onlyTestsAndSuites = preprocessRoot._getOnlyItems();
    if (onlyTestsAndSuites.length > 0)
      errors.push(...createForbidOnlyErrors(onlyTestsAndSuites));
  }

  // Filter only.
  if (!options.listOnly)
    filterOnly(preprocessRoot);

  return await createRootSuite(preprocessRoot, options.testTitleMatcher, filesByProject);
}

async function loadTests(configLoader: ConfigLoader, reporter: Multiplexer, testFiles: Set<string>, errors: TestError[]): Promise<Suite> {
  if (process.env.PW_TEST_OOP_LOADER) {
    const loaderHost = new LoaderHost();
    await loaderHost.start(configLoader.serializedConfig());
    try {
      return await loaderHost.loadTestFiles([...testFiles], reporter);
    } finally {
      await loaderHost.stop();
    }
  }
  const loadErrors: LoadError[] = [];
  try {
    return await loadTestFilesInProcess(configLoader.fullConfig(), [...testFiles], loadErrors);
  } finally {
    errors.push(...loadErrors);
  }
}

function createFileMatcherFromFilter(filter: TestFileFilter) {
  const fileMatcher = createFileMatcher(filter.re || filter.exact || '');
  return (testFileName: string, testLine: number, testColumn: number) =>
    fileMatcher(testFileName) && (filter.line === testLine || filter.line === null) && (filter.column === testColumn || filter.column === null);
}

function filterByFocusedLine(suite: Suite, focusedTestFileLines: TestFileFilter[]) {
  if (!focusedTestFileLines.length)
    return;
  const matchers = focusedTestFileLines.map(createFileMatcherFromFilter);
  const testFileLineMatches = (testFileName: string, testLine: number, testColumn: number) => matchers.some(m => m(testFileName, testLine, testColumn));
  const suiteFilter = (suite: Suite) => !!suite.location && testFileLineMatches(suite.location.file, suite.location.line, suite.location.column);
  const testFilter = (test: TestCase) => testFileLineMatches(test.location.file, test.location.line, test.location.column);
  return filterSuite(suite, suiteFilter, testFilter);
}

function createForbidOnlyErrors(onlyTestsAndSuites: (TestCase | Suite)[]): TestError[] {
  const errors: TestError[] = [];
  for (const testOrSuite of onlyTestsAndSuites) {
    // Skip root and file.
    const title = testOrSuite.titlePath().slice(2).join(' ');
    const error: TestError = {
      message: `Error: focused item found in the --forbid-only mode: "${title}"`,
      location: testOrSuite.location!,
    };
    errors.push(error);
  }
  return errors;
}

function createDuplicateTitlesErrors(config: FullConfigInternal, rootSuite: Suite): TestError[] {
  const errors: TestError[] = [];
  for (const fileSuite of rootSuite.suites) {
    const testsByFullTitle = new Map<string, TestCase>();
    for (const test of fileSuite.allTests()) {
      const fullTitle = test.titlePath().slice(2).join(' › ');
      const existingTest = testsByFullTitle.get(fullTitle);
      if (existingTest) {
        const error: TestError = {
          message: `Error: duplicate test title "${fullTitle}", first declared in ${buildItemLocation(config.rootDir, existingTest)}`,
          location: test.location,
        };
        errors.push(error);
      }
      testsByFullTitle.set(fullTitle, test);
    }
  }
  return errors;
}

function buildItemLocation(rootDir: string, testOrSuite: Suite | TestCase) {
  if (!testOrSuite.location)
    return '';
  return `${path.relative(rootDir, testOrSuite.location.file)}:${testOrSuite.location.line}`;
}