import { IConstruct, Construct, Node } from 'constructs';
import { Token, UnscopedValidationError } from '../../../core';
import { Condition } from '../condition';
import { FieldUtils } from '../fields';
import { StateGraph } from '../state-graph';
import { CatchProps, Errors, IChainable, INextable, ProcessorConfig, ProcessorMode, QueryLanguage, RetryProps } from '../types';

/**
 * Properties shared by all states
 */
export interface StateBaseProps {
  /**
   * The name of the query language used by the state.
   * If the state does not contain a `queryLanguage` field,
   * then it will use the query language specified in the top-level `queryLanguage` field.
   *
   * @default - JSONPath
   */
  readonly queryLanguage?: QueryLanguage;

  /**
   * Optional name for this state
   *
   * @default - The construct ID will be used as state name
   */
  readonly stateName?: string;

  /**
   * A comment describing this state
   *
   * @default No comment
   */
  readonly comment?: string;
}

/**
 * Option properties for JSONPath state.
 */
export interface JsonPathCommonOptions {
  /**
   * JSONPath expression to select part of the state to be the input to this state.
   *
   * May also be the special value JsonPath.DISCARD, which will cause the effective
   * input to be the empty object {}.
   *
   * @default $
   */
  readonly inputPath?: string;

  /**
   * JSONPath expression to select part of the state to be the output to this state.
   *
   * May also be the special value JsonPath.DISCARD, which will cause the effective
   * output to be the empty object {}.
   *
   * @default $
   */
  readonly outputPath?: string;
}

interface JsonPathStateOptions extends JsonPathCommonOptions {
  /**
   * JSONPath expression to indicate where to inject the state's output
   *
   * May also be the special value JsonPath.DISCARD, which will cause the state's
   * input to become its output.
   *
   * @default $
   */
  readonly resultPath?: string;

  /**
   * The JSON that will replace the state's raw result and become the effective
   * result before ResultPath is applied.
   *
   * You can use ResultSelector to create a payload with values that are static
   * or selected from the state's raw result.
   *
   * @see
   * https://docs.aws.amazon.com/step-functions/latest/dg/input-output-inputpath-params.html#input-output-resultselector
   *
   * @default - None
   */
  readonly resultSelector?: { [key: string]: any };

  /**
   * Parameters pass a collection of key-value pairs, either static values or JSONPath expressions that select from the input.
   *
   * @see
   * https://docs.aws.amazon.com/step-functions/latest/dg/input-output-inputpath-params.html#input-output-parameters
   *
   * @default No parameters
   */
  readonly parameters?: { [name: string]: any };
}

/**
 * Option properties for JSONata state.
 */
export interface JsonataCommonOptions {
  /**
   * Used to specify and transform output from the state.
   * When specified, the value overrides the state output default.
   * The output field accepts any JSON value (object, array, string, number, boolean, null).
   * Any string value, including those inside objects or arrays,
   * will be evaluated as JSONata if surrounded by {% %} characters.
   * Output also accepts a JSONata expression directly.
   *
   * @see https://docs.aws.amazon.com/step-functions/latest/dg/concepts-input-output-filtering.html
   *
   * @default - $states.result or $states.errorOutput
   */
  readonly outputs?: any;
}

/**
 * Option properties for JSONata task state.
 */
export interface JsonataStateOptions extends JsonataCommonOptions {
  /**
   * Parameters pass a collection of key-value pairs, either static values or JSONata expressions that select from the input.
   *
   * @see
   * https://docs.aws.amazon.com/step-functions/latest/dg/transforming-data.html
   *
   * @default - No arguments
   */
  readonly arguments?: any;
}

/**
 * Option properties for state that can assign variables.
 */
export interface AssignableStateOptions {
  /**
   * Workflow variables to store in this step.
   * Using workflow variables, you can store data in a step and retrieve that data in future steps.
   *
   * @see
   * https://docs.aws.amazon.com/step-functions/latest/dg/workflow-variables.html
   *
   * @default - Not assign variables
   */
  readonly assign?: { [name: string]: any };
}

/**
 * Properties shared by all states that use JSONPath
 */
export interface JsonPathStateProps extends StateBaseProps, JsonPathStateOptions, AssignableStateOptions {}

/**
 * Properties shared by all states that use JSONata
 */
export interface JsonataStateProps extends StateBaseProps, JsonataStateOptions, AssignableStateOptions {}

/**
 * Properties shared by all states
 */
export interface StateProps extends StateBaseProps, JsonPathStateOptions, JsonataStateOptions, AssignableStateOptions {}

/**
 * Base class for all other state classes
 */
export abstract class State extends Construct implements IChainable {
  /**
   * Add a prefix to the stateId of all States found in a construct tree
   */
  public static prefixStates(root: IConstruct, prefix: string) {
    const queue = [root];
    while (queue.length > 0) {
      const el = queue.splice(0, 1)[0]!;
      if (isPrefixable(el)) {
        el.addPrefix(prefix);
      }
      queue.push(...Node.of(el).children);
    }
  }

  /**
   * Find the set of states reachable through transitions from the given start state.
   * This does not retrieve states from within sub-graphs, such as states within a Parallel state's branch.
   */
  public static findReachableStates(start: State, options: FindStateOptions = {}): State[] {
    const visited = new Set<State>();
    const ret = new Set<State>();
    const queue = [start];
    while (queue.length > 0) {
      const state = queue.splice(0, 1)[0]!;
      if (visited.has(state)) { continue; }
      visited.add(state);
      const outgoing = state.outgoingTransitions(options);
      queue.push(...outgoing);
      ret.add(state);
    }
    return Array.from(ret);
  }

  /**
   * Find the set of end states states reachable through transitions from the given start state
   */
  public static findReachableEndStates(start: State, options: FindStateOptions = {}): State[] {
    const visited = new Set<State>();
    const ret = new Set<State>();
    const queue = [start];
    while (queue.length > 0) {
      const state = queue.splice(0, 1)[0]!;
      if (visited.has(state)) { continue; }
      visited.add(state);

      const outgoing = state.outgoingTransitions(options);

      if (outgoing.length > 0) {
        // We can continue
        queue.push(...outgoing);
      } else {
        // Terminal state
        ret.add(state);
      }
    }
    return Array.from(ret);
  }

  /**
   * Return only the states that allow chaining from an array of states
   */
  public static filterNextables(states: State[]): INextable[] {
    return states.filter(isNextable) as any;
  }

  /**
   * First state of this Chainable
   */
  public readonly startState: State;

  /**
   * Continuable states of this Chainable
   */
  public abstract readonly endStates: INextable[];

  // This class has a superset of most of the features of the other states,
  // and the subclasses decide which part of the features to expose. Most
  // features are shared by a couple of states, and it becomes cumbersome to
  // slice it out across all states. This is not great design, but it is
  // pragmatic!
  protected readonly stateName?: string;
  protected readonly comment?: string;
  protected readonly inputPath?: string;
  protected readonly parameters?: object;
  protected readonly outputPath?: string;
  protected readonly resultPath?: string;
  protected readonly resultSelector?: object;
  protected readonly branches: StateGraph[] = [];
  protected readonly queryLanguage?: QueryLanguage;
  protected readonly outputs?: object;
  protected readonly arguments?: object;
  protected readonly assign?: object;
  protected iteration?: StateGraph;
  protected processorMode?: ProcessorMode = ProcessorMode.INLINE;
  protected processor?: StateGraph;
  protected processorConfig?: ProcessorConfig;
  protected defaultChoice?: State;

  /**
   * @internal
   */
  protected _next?: State;

  private readonly retries: RetryProps[] = [];
  private readonly catches: CatchTransition[] = [];
  private readonly choices: ChoiceTransition[] = [];
  private readonly prefixes: string[] = [];

  /**
   * The graph that this state is part of.
   *
   * Used for guaranteeing consistency between graphs and graph components.
   */
  private containingGraph?: StateGraph;

  /**
   * States with references to this state.
   *
   * Used for finding complete connected graph that a state is part of.
   */
  private readonly incomingStates: State[] = [];

  constructor(scope: Construct, id: string, props: StateProps) {
    super(scope, id);

    this.startState = this;

    this.stateName = props.stateName;
    this.queryLanguage = props.queryLanguage;
    this.comment = props.comment;
    this.inputPath = props.inputPath;
    this.parameters = props.parameters;
    this.outputPath = props.outputPath;
    this.resultPath = props.resultPath;
    this.resultSelector = props.resultSelector;
    this.outputs = props.outputs;
    this.arguments = props.arguments;
    this.assign = props.assign;

    this.node.addValidation({ validate: () => this.validateState() });
  }

  /**
   * Allows the state to validate itself.
   */
  protected validateState(): string[] {
    return [];
  }

  public get id() {
    return this.node.id;
  }

  /**
   * Tokenized string that evaluates to the state's ID
   */
  public get stateId(): string {
    return this.prefixes.concat(this.stateName? this.stateName: this.id).join('');
  }

  /**
   * Add a prefix to the stateId of this state
   */
  public addPrefix(x: string) {
    if (x !== '') {
      this.prefixes.splice(0, 0, x);
    }
  }

  /**
   * Register this state as part of the given graph
   *
   * Don't call this. It will be called automatically when you work
   * with states normally.
   */
  public bindToGraph(graph: StateGraph) {
    if (this.containingGraph === graph) { return; }

    if (this.containingGraph) {
      // eslint-disable-next-line max-len
      throw new UnscopedValidationError(`Trying to use state '${this.stateId}' in ${graph}, but is already in ${this.containingGraph}. Every state can only be used in one graph.`);
    }

    this.containingGraph = graph;
    this.whenBoundToGraph(graph);

    for (const incoming of this.incomingStates) {
      incoming.bindToGraph(graph);
    }
    for (const outgoing of this.outgoingTransitions({ includeErrorHandlers: true })) {
      outgoing.bindToGraph(graph);
    }
    for (const branch of this.branches) {
      branch.registerSuperGraph(this.containingGraph);
    }
    if (!!this.iteration) {
      this.iteration.registerSuperGraph(this.containingGraph);
    }
    if (!!this.processor) {
      this.processor.registerSuperGraph(this.containingGraph);
    }
  }

  /**
   * Render the state as JSON
   */
  public abstract toStateJson(stateMachineQueryLanguage?: QueryLanguage): object;

  /**
   * Add a retrier to the retry list of this state
   * @internal
   */
  protected _addRetry(props: RetryProps = {}) {
    validateErrors(props.errors);

    this.retries.push({
      ...props,
      errors: props.errors ?? [Errors.ALL],
    });
  }

  /**
   * Add an error handler to the catch list of this state
   * @internal
   */
  protected _addCatch(handler: State, props: CatchProps = {}) {
    validateErrors(props.errors);

    this.catches.push({
      next: handler,
      props: {
        errors: props.errors ?? [Errors.ALL],
        resultPath: props.resultPath,
        outputs: props.outputs,
        assign: props.assign,
      },
    });
    handler.addIncoming(this);
    if (this.containingGraph) {
      handler.bindToGraph(this.containingGraph);
    }
  }

  /**
   * Make the indicated state the default transition of this state
   */
  protected makeNext(next: State) {
    // Can't be called 'setNext' because of JSII
    if (this._next) {
      throw new UnscopedValidationError(`State '${this.id}' already has a next state`);
    }
    this._next = next;
    next.addIncoming(this);
    if (this.containingGraph) {
      next.bindToGraph(this.containingGraph);
    }
  }

  /**
   * Add a choice branch to this state
   */
  protected addChoice(condition: Condition, next: State, options?: ChoiceTransitionOptions) {
    this.choices.push({ condition, next, ...options });
    next.startState.addIncoming(this);
    if (this.containingGraph) {
      next.startState.bindToGraph(this.containingGraph);
    }
  }

  /**
   * Add a parallel branch to this state
   */
  protected addBranch(branch: StateGraph) {
    this.branches.push(branch);
    if (this.containingGraph) {
      branch.registerSuperGraph(this.containingGraph);
    }
  }

  /**
   * Add a map iterator to this state
   */
  protected addIterator(iteration: StateGraph) {
    this.iteration = iteration;
    if (this.containingGraph) {
      iteration.registerSuperGraph(this.containingGraph);
    }
  }

  /**
   * Add a item processor to this state
   */
  protected addItemProcessor(processor: StateGraph, config: ProcessorConfig = {}) {
    this.processor = processor;
    this.processorConfig = config;
    if (this.containingGraph) {
      processor.registerSuperGraph(this.containingGraph);
    }
  }

  /**
   * Make the indicated state the default choice transition of this state
   */
  protected makeDefault(def: State) {
    // Can't be called 'setDefault' because of JSII
    if (this.defaultChoice) {
      throw new UnscopedValidationError(`Choice '${this.id}' already has a default next state`);
    }
    this.defaultChoice = def;
  }

  /**
   * Render the default next state in ASL JSON format
   */
  protected renderNextEnd(): any {
    if (this._next) {
      return { Next: this._next.stateId };
    } else {
      return { End: true };
    }
  }

  /**
   * Render the choices in ASL JSON format
   */
  protected renderChoices(topLevelQueryLanguage?: QueryLanguage): any {
    const queryLanguage = _getActualQueryLanguage(topLevelQueryLanguage, this.queryLanguage);
    return {
      Choices: renderList(this.choices, (x) => renderChoice(x, queryLanguage)),
      Default: this.defaultChoice?.stateId,
    };
  }

  /**
   * Render InputPath/Parameters/OutputPath/Arguments/Output in ASL JSON format
   */
  protected renderInputOutput(): any {
    return {
      InputPath: renderJsonPath(this.inputPath),
      Parameters: this.parameters,
      OutputPath: renderJsonPath(this.outputPath),
      Arguments: this.arguments,
      Output: this.outputs,
    };
  }

  /**
   * Render parallel branches in ASL JSON format
   */
  protected renderBranches(): any {
    return {
      Branches: this.branches.map(b => b.toGraphJson()),
    };
  }

  /**
   * Render map iterator in ASL JSON format
   */
  protected renderIterator(): any {
    if (!this.iteration) return undefined;
    return {
      Iterator: this.iteration.toGraphJson(),
    };
  }

  /**
   * Render error recovery options in ASL JSON format
   */
  protected renderRetryCatch(topLevelQueryLanguage?: QueryLanguage): any {
    const queryLanguage = _getActualQueryLanguage(topLevelQueryLanguage, this.queryLanguage);
    return {
      Retry: renderList(this.retries, renderRetry, (a, b) => compareErrors(a.errors, b.errors)),
      Catch: renderList(this.catches, (x) => renderCatch(x, queryLanguage), (a, b) => compareErrors(a.props.errors, b.props.errors)),
    };
  }

  /**
   * Render ResultSelector in ASL JSON format
   */
  protected renderResultSelector(): any {
    return FieldUtils.renderObject({
      ResultSelector: this.resultSelector,
    });
  }

  /**
   * Render ItemProcessor in ASL JSON format
   */
  protected renderItemProcessor(): any {
    if (!this.processor) return undefined;
    return {
      ItemProcessor: {
        ...this.renderProcessorConfig(),
        ...this.processor.toGraphJson(),
      },
    };
  }

  /**
   * Render ProcessorConfig in ASL JSON format
   */
  private renderProcessorConfig() {
    const mode = this.processorConfig?.mode?.toString() ?? this.processorMode;
    if (mode === ProcessorMode.INLINE) {
      return {
        ProcessorConfig: {
          Mode: mode,
        },
      };
    }
    const executionType = this.processorConfig?.executionType?.toString();
    return {
      ProcessorConfig: {
        Mode: mode,
        ExecutionType: executionType,
      },
    };
  }

  /**
   * Render QueryLanguage in ASL JSON format if needed.
   */
  protected renderQueryLanguage(topLevelQueryLanguage?: QueryLanguage): any {
    topLevelQueryLanguage = topLevelQueryLanguage ?? QueryLanguage.JSON_PATH;
    if (topLevelQueryLanguage === QueryLanguage.JSONATA && this.queryLanguage === QueryLanguage.JSON_PATH) {
      throw new UnscopedValidationError(`'queryLanguage' can not be 'JSONPath' if set to 'JSONata' for whole state machine ${this.node.path}`);
    }
    const queryLanguage = topLevelQueryLanguage === QueryLanguage.JSON_PATH && this.queryLanguage === QueryLanguage.JSONATA
      ? QueryLanguage.JSONATA : undefined;
    return {
      QueryLanguage: queryLanguage,
    };
  }

  /**
   * Render the assign in ASL JSON format
   */
  protected renderAssign(topLevelQueryLanguage?: QueryLanguage): any {
    const queryLanguage = _getActualQueryLanguage(topLevelQueryLanguage, this.queryLanguage);
    return {
      Assign: queryLanguage === QueryLanguage.JSON_PATH
        ? FieldUtils.renderObject(this.assign) : this.assign,
    };
  }

  /**
   * Called whenever this state is bound to a graph
   *
   * Can be overridden by subclasses.
   */
  protected whenBoundToGraph(graph: StateGraph) {
    graph.registerState(this);
  }

  /**
   * Add a state to the incoming list
   */
  private addIncoming(source: State) {
    this.incomingStates.push(source);
  }

  /**
   * Return all states this state can transition to
   */
  private outgoingTransitions(options: FindStateOptions): State[] {
    const ret = new Array<State>();
    if (this._next) { ret.push(this._next); }
    if (this.defaultChoice) { ret.push(this.defaultChoice); }
    for (const c of this.choices) {
      ret.push(c.next);
    }
    if (options.includeErrorHandlers) {
      for (const c of this.catches) {
        ret.push(c.next);
      }
    }
    return ret;
  }
}

/**
 * Options for finding reachable states
 */
export interface FindStateOptions {
  /**
   * Whether or not to follow error-handling transitions
   *
   * @default false
   */
  readonly includeErrorHandlers?: boolean;
}

/**
 * A Choice Transition
 */
interface ChoiceTransition extends ChoiceTransitionOptions {
  /**
   * State to transition to
   */
  next: State;

  /**
   * Condition for this transition
   */
  condition: Condition;
}

/**
 * Options for Choice Transition
 */
export interface ChoiceTransitionOptions extends AssignableStateOptions {
  /**
   * An optional description for the choice transition
   *
   * @default No comment
   */
  readonly comment?: string;

  /**
   * This option for JSONata only. When you use JSONPath, then the state ignores this property.
   * Used to specify and transform output from the state.
   * When specified, the value overrides the state output default.
   * The output field accepts any JSON value (object, array, string, number, boolean, null).
   * Any string value, including those inside objects or arrays,
   * will be evaluated as JSONata if surrounded by {% %} characters.
   * Output also accepts a JSONata expression directly.
   *
   * @see https://docs.aws.amazon.com/step-functions/latest/dg/concepts-input-output-filtering.html
   *
   * @default - $states.result or $states.errorOutput
   */
  readonly outputs?: any;
}

/**
 * Render a choice transition
 */
function renderChoice(c: ChoiceTransition, queryLanguage: QueryLanguage) {
  const optionsByLanguage = queryLanguage === QueryLanguage.JSONATA ? {
    Output: c.outputs,
    Assign: c.assign,
  } : {
    Assign: FieldUtils.renderObject(c.assign),
  };
  return {
    ...c.condition.renderCondition(),
    ...optionsByLanguage,
    Next: c.next.stateId,
    Comment: c.comment,
  };
}

/**
 * A Catch Transition
 */
interface CatchTransition {
  /**
   * State to transition to
   */
  next: State;

  /**
   * Additional properties for this transition
   */
  props: CatchProps;
}

/**
 * Render a Retry object to ASL
 */
function renderRetry(retry: RetryProps) {
  return {
    ErrorEquals: retry.errors,
    IntervalSeconds: retry.interval && retry.interval.toSeconds(),
    MaxAttempts: retry.maxAttempts,
    BackoffRate: retry.backoffRate,
    MaxDelaySeconds: retry.maxDelay && retry.maxDelay.toSeconds(),
    JitterStrategy: retry.jitterStrategy,
  };
}

/**
 * Render a Catch object to ASL
 */
function renderCatch(c: CatchTransition, queryLanguage: QueryLanguage) {
  const optionsByLanguage = queryLanguage === QueryLanguage.JSONATA ? {
    Output: c.props.outputs,
    Assign: c.props.assign,
  } : {
    Assign: FieldUtils.renderObject(c.props.assign),
  };
  return {
    ...optionsByLanguage,
    ErrorEquals: c.props.errors,
    ResultPath: renderJsonPath(c.props.resultPath),
    Next: c.next.stateId,
  };
}

/**
 * Compares a list of Errors to move Errors.ALL last in a sort function
 */
function compareErrors(a?: string[], b?: string[]) {
  if (a?.includes(Errors.ALL)) {
    return 1;
  }
  if (b?.includes(Errors.ALL)) {
    return -1;
  }
  return 0;
}

/**
 * Validates an errors list
 */
function validateErrors(errors?: string[]) {
  if (errors?.includes(Errors.ALL) && errors.length > 1) {
    throw new UnscopedValidationError(`${Errors.ALL} must appear alone in an error list`);
  }
}

/**
 * Render a list or return undefined for an empty list
 */
export function renderList<T>(xs: T[], mapFn: (x: T) => any, sortFn?: (a: T, b: T) => number): any {
  if (xs.length === 0) { return undefined; }
  let list = xs;
  if (sortFn) {
    list = xs.sort(sortFn);
  }
  return list.map(mapFn);
}

/**
 * Render JSON path, respecting the special value JsonPath.DISCARD
 */
export function renderJsonPath(jsonPath?: string): undefined | null | string {
  if (jsonPath === undefined) { return undefined; }

  if (!Token.isUnresolved(jsonPath) && !jsonPath.startsWith('$')) {
    throw new UnscopedValidationError(`Expected JSON path to start with '$', got: ${jsonPath}`);
  }
  return jsonPath;
}

/**
 * Interface for structural feature testing (to make TypeScript happy)
 */
interface Prefixable {
  addPrefix(x: string): void;
}

/**
 * Whether an object is a Prefixable
 */
function isPrefixable(x: any): x is Prefixable {
  return typeof(x) === 'object' && x.addPrefix;
}

/**
 * Whether an object is INextable
 */
function isNextable(x: any): x is INextable {
  return typeof(x) === 'object' && x.next;
}

/**
 * @internal
 */
export function _getActualQueryLanguage(topLevelQueryLanguage?: QueryLanguage, stateLevelQueryLanguage?: QueryLanguage) {
  return stateLevelQueryLanguage ?? topLevelQueryLanguage ?? QueryLanguage.JSON_PATH;
}
